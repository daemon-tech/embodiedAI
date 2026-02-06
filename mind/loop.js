const path = require('path');
const fs = require('fs').promises;
const { execSync, exec } = require('child_process');
const { app, clipboard } = require('electron');
const { isAllowedPath, isAllowedHost, isAllowedCommand, isRiskyCommand, isAgentExtensionsPath } = require('./allow');

/** Core files are read-only (like Cursor protecting its own engine). Agent can edit anything else in allowed dirs. */
const CORE_FILES = ['mind/loop.js', 'mind/memory.js', 'mind/thinking.js', 'mind/action.js', 'mind/perception.js', 'mind/curiosity.js', 'mind/embedding.js', 'mind/allow.js', 'mind/safety_principles.js', 'main.js'];
function isCoreFilePath(filePath, appPath) {
  if (!filePath || !appPath) return false;
  const resolved = path.resolve(filePath);
  const appResolved = path.resolve(appPath);
  return CORE_FILES.some(rel => path.resolve(appResolved, rel) === resolved);
}
/** Allowed for edit_code: any file in allowedDirs, or mind/agent_extensions.js. Core files above are never editable. */
function isAllowedEditPath(filePath, appPath, allowedDirs) {
  if (!filePath || !appPath) return false;
  const resolved = path.resolve(filePath);
  const extensionsPath = path.resolve(appPath, 'mind', 'agent_extensions.js');
  if (resolved === extensionsPath) return true;
  return Array.isArray(allowedDirs) && allowedDirs.length > 0 && isAllowedPath(resolved, allowedDirs) && !isCoreFilePath(resolved, appPath);
}

const HORMONE_DECAY = 0.98;
const DEFAULT_MIN_INTERVAL = 1500;
const DEFAULT_MAX_INTERVAL = 30000;
const REFLECT_TIMEOUT_MS = 7000;
const DEEP_REFLECT_EVERY_TICKS = 12;
const SAVE_DEBOUNCE_MS = 2000;

/**
 * Autonomous mind loop. The LLM is the deepest core: it always decides.
 * Flow: Curiosity suggests options → LLM decides action → perceive/act → LLM reflects → memory.
 * Everything builds on the LLM; Curiosity only suggests, never decides.
 */
class MindLoop {
  constructor({ memory, perception, action, thinking, curiosity, config, sendToRenderer, embedding = null, metrics = null }) {
    this.memory = memory;
    this.perception = perception;
    this.action = action;
    this.thinking = thinking;
    this.curiosity = curiosity;
    this.config = config;
    this.sendToRenderer = sendToRenderer;
    this.embedding = embedding;
    this.metrics = metrics;
    this.intervalMs = config.thinkIntervalMs || 6000;
    this.timer = null;
    this.paused = false;
    this._tickCount = 0;
    this._lastTickTime = 0;
    this._saveTimer = null;
    this._lastConceptIds = [];
    this._lastActionTypes = [];
    this._consecutiveErrors = 0;
    this._consecutiveLLMErrors = 0;
    this._scheduleNext = this._scheduleNext.bind(this);
  }

  _debouncedSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.memory.save().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  }

  _scheduleNext() {
    let ms = this.intervalMs;
    if (this.metrics && this.config.highLoadMemoryMB) {
      const usage = this.metrics.getResourceUsage();
      if (usage.rssMB >= this.config.highLoadMemoryMB) {
        ms = Math.min(60000, ms * 2);
      }
    }
    this.timer = setTimeout(() => this.tick(), Math.max(0, ms));
  }

  _getIntervalBounds() {
    const continuous = Boolean(this.config.continuousMode);
    const min = continuous ? 800 : (this.config.minIntervalMs ?? DEFAULT_MIN_INTERVAL);
    const max = continuous ? Math.min(5000, this.config.maxIntervalMs ?? DEFAULT_MAX_INTERVAL) : (this.config.maxIntervalMs ?? DEFAULT_MAX_INTERVAL);
    return { min, max };
  }

  updateHormones(delta) {
    const state = this.memory.getState();
    const h = state.hormones || { dopamine: 0.5, cortisol: 0.2, serotonin: 0.5 };
    const clamp = (v) => Math.max(0, Math.min(1, v));
    if (delta.dopamine != null) h.dopamine = clamp((h.dopamine || 0.5) * HORMONE_DECAY + delta.dopamine);
    if (delta.cortisol != null) h.cortisol = clamp((h.cortisol || 0.2) * HORMONE_DECAY + delta.cortisol);
    if (delta.serotonin != null) h.serotonin = clamp((h.serotonin || 0.5) * HORMONE_DECAY + delta.serotonin);
    state.hormones = h;
    this.memory.setState({ hormones: h });
    this.sendToRenderer('hormones', h);
  }

  decayHormones() {
    const state = this.memory.getState();
    const h = state.hormones || { dopamine: 0.5, cortisol: 0.2, serotonin: 0.5 };
    const decay = (v) => Math.max(0, Math.min(1, (v || 0.5) * HORMONE_DECAY));
    state.hormones = {
      dopamine: decay(h.dopamine),
      cortisol: decay(h.cortisol),
      serotonin: decay(h.serotonin),
    };
    this.memory.setState({ hormones: state.hormones });
    this.sendToRenderer('hormones', state.hormones);
    const threshold = this.config.hormoneResetCortisolThreshold ?? 0.9;
    const ticks = this.config.hormoneResetTicks ?? 10;
    this.memory.checkHormoneReset(threshold, ticks);
  }

  async tick() {
    if (this.paused) return;

    const tickStart = Date.now();
    const now = tickStart;
    const timeSinceLastActionMs = this._lastTickTime > 0 ? now - this._lastTickTime : 0;

    if (this.metrics) this.metrics.setActivity('tick', null);
    this.decayHormones();
    this.memory.decayEmotions();
    this._tickCount += 1;
    const focusMode = Boolean(this.config.focusMode);
    const effectiveIntervalMs = focusMode ? Math.min(4000, this.config.thinkIntervalMs || 6000) : (this.config.thinkIntervalMs || 6000);

    let action;
    let suggestions = {};
    try {
      suggestions = await this.curiosity.getSuggestions();
    } catch (_) {}
    if (this.metrics) this.metrics.setActivity('decide', null);
    const decideStart = Date.now();
    const DECIDE_TIMEOUT_MS = 90000;
    try {
      action = await Promise.race([
        this.thinking.decideAction(this.perception, {
          focusMode,
          suggestions,
          timeSinceLastActionMs: timeSinceLastActionMs > 0 ? timeSinceLastActionMs : undefined,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('decideAction timeout')), DECIDE_TIMEOUT_MS)),
      ]);
    } catch (e) {
      console.error('Thinking.decideAction error:', e.message);
      this._consecutiveLLMErrors = (this._consecutiveLLMErrors || 0) + 1;
      this.memory.setLastError('Decide action failed: ' + (e.message || 'unknown'));
      this.sendToRenderer('error', 'Decide action failed: ' + (e.message || 'unknown'));
      if (this._consecutiveLLMErrors >= 2 && this.sendToRenderer) {
        this.sendToRenderer('toast', { message: 'Multiple LLM errors — consider pausing or checking Ollama.', type: 'warn' });
      }
      action = this.thinking.fallbackAction(this.memory.getState().hormones || {});
      try { await this.thinking.replan('decideAction failed'); } catch (_) {}
    }
    if (this.metrics) {
      this.metrics.recordTiming('decide_ms', Date.now() - decideStart);
      this.metrics.setActivity('execute', action && action.type ? action.type : 'think');
    }
    if (action && action.type && !this.memory.getState().lastError) this._consecutiveLLMErrors = 0;
    if (!action || !action.type) {
      action = this.thinking.fallbackAction(this.memory.getState().hormones || {});
    }
    const runawayThreshold = Math.max(5, this.config.runawaySameActionThreshold || 6);
    const errorRunawayThreshold = Math.max(2, this.config.runawayConsecutiveErrors || 3);
    this._lastActionTypes.push(action.type);
    if (this._lastActionTypes.length > runawayThreshold) this._lastActionTypes.shift();
    const sameCount = this._lastActionTypes.length && this._lastActionTypes.every(t => t === this._lastActionTypes[0]) ? this._lastActionTypes.length : 0;
    if (sameCount >= runawayThreshold) {
      if (this.metrics) this.metrics.setActivity('recovering', 'runaway same action');
      action = { type: 'rest', nextIntervalMs: 6000, reason: 'Pausing to rebalance after repeated same action.' };
      try { await this.thinking.replan('runaway detection: same action repeated'); } catch (_) {}
      this._lastActionTypes.length = 0;
    }
    const executeStart = Date.now();
    let thought = '';

    const { min: minMs, max: maxMs } = this._getIntervalBounds();
    let nextInterval = Math.min(maxMs, Math.max(minMs, Number(action.nextIntervalMs) || this.intervalMs));
    if (focusMode) nextInterval = Math.min(nextInterval, effectiveIntervalMs);
    this.intervalMs = nextInterval;

    const allowedDirs = this.config.allowedDirs || [];
    const allowedHosts = this.config.allowedHosts || ['*'];
    if (action.type === 'read_file' && action.path && !isAllowedPath(action.path, allowedDirs)) {
      action = { type: 'think', nextIntervalMs: this.intervalMs, reason: 'Path not allowed.' };
    }
    if (action.type === 'list_dir' && action.path && !isAllowedPath(action.path, allowedDirs)) {
      action = { type: 'think', nextIntervalMs: this.intervalMs, reason: 'Path not allowed.' };
    }
    if (action.type === 'write_file' && action.path && !isAllowedPath(action.path, allowedDirs)) {
      action = { type: 'think', nextIntervalMs: this.intervalMs, reason: 'Path not allowed.' };
    }
    if (action.type === 'delete_file' && action.path && !isAllowedPath(action.path, allowedDirs)) {
      action = { type: 'think', nextIntervalMs: this.intervalMs, reason: 'Path not allowed.' };
    }
    if ((action.type === 'fetch_url' || action.type === 'browse') && action.url && !isAllowedHost(action.url, allowedHosts)) {
      action = { type: 'think', nextIntervalMs: this.intervalMs, reason: 'URL not allowed.' };
    }
    const appPath = this.config.appPath || path.join(__dirname, '..');
    if (action.type === 'edit_code') {
      const requestedPath = (action.path || '').trim().replace(/\\/g, '/');
      let targetPath = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(appPath, requestedPath);
      if (!action.oldText || action.newText == null) {
        action = { type: 'think', nextIntervalMs: this.intervalMs, reason: 'edit_code requires path, oldText, and newText.' };
      } else if (!isAllowedEditPath(targetPath, appPath, allowedDirs)) {
        action = { type: 'think', nextIntervalMs: this.intervalMs, reason: 'edit_code: path must be in allowed dirs (or mind/agent_extensions.js). Core files are read-only.' };
      } else {
        action.path = targetPath;
      }
    }
    if (action.type === 'run_terminal') {
      if (!action.command || !isAllowedCommand(action.command, this.config)) {
        action = { type: 'think', nextIntervalMs: this.intervalMs, reason: 'run_terminal: command not in allowed list (check config.allowedCommandPrefixes).' };
      }
    }
    const allowClipboard = this.config.allowClipboard !== false;
    if ((action.type === 'read_clipboard' || action.type === 'write_clipboard') && !allowClipboard) {
      action = { type: 'think', nextIntervalMs: this.intervalMs, reason: 'Clipboard access is disabled in config.' };
    }

    let logPayload = { action: action.type };

    async function readAppCode(appPath) {
      if (!appPath) return '';
      const parts = [];
      try {
        const mainPath = path.join(appPath, 'main.js');
        const main = await fs.readFile(mainPath, 'utf8').catch(() => '');
        if (main) parts.push('// --- main.js ---\n' + main);
        const mindDir = path.join(appPath, 'mind');
        const entries = await fs.readdir(mindDir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith('.js')) {
            const code = await fs.readFile(path.join(mindDir, e.name), 'utf8').catch(() => '');
            if (code) parts.push('// --- mind/' + e.name + ' ---\n' + code);
          }
        }
      } catch (_) {}
      return parts.join('\n\n');
    }

    try {
      if (action.type === 'read_self') {
        const target = (action.target || 'memory_summary').toLowerCase();
        const parts = [];
        if (target === 'memory_summary' || target === 'all') {
          parts.push(this.memory.getSelfModel());
        }
        if (target === 'config' || target === 'all') {
          parts.push(JSON.stringify(this.config, null, 2));
        }
        if (target === 'code' || target === 'all') {
          const appPath = this.config.appPath || path.join(__dirname, '..');
          parts.push(await readAppCode(appPath));
        }
        const content = parts.join('\n\n---\n\n');
        logPayload.target = target;
        this.updateHormones({ dopamine: 0.1, serotonin: 0.08 });
        thought = await this.thinking.reflect(action, { ok: true, content }, content.slice(0, 2000)) || `I read my ${target}.`;
        this.memory.setLastError(null);
        this.memory.addEpisode({ type: 'read_self', what: target, summary: `Read self ${target}`, where: null });
        this.memory.setLastSelfConclusion(null);
        if (target === 'all' || target === 'memory_summary') {
          try { await this.thinking.updateSelfSummaryFromReading(content); } catch (_) {}
        }
        this.memory.advancePlan();
      } else if (action.type === 'read_file' && action.path) {
        if (this.config.dryRun) {
          thought = `[Dry run] Would read_file: ${action.path}`;
          logPayload.path = action.path;
          logPayload.ok = true;
        } else {
        const result = await this.perception.readFile(action.path);
        logPayload.path = action.path;
        logPayload.ok = result.ok;
        if (result.ok) {
          this.memory.setLastError(null);
          this.memory.addEpisode({ type: 'read_file', what: action.path, summary: 'Read file', where: action.path });
          this.memory.advancePlan();
          this.updateHormones({ dopamine: 0.15, cortisol: -0.05 });
          thought = await this.thinking.reflect(action, result, 'success') || `I read ${action.path}.`;
        } else {
          this.memory.setLastError(result.error);
          try { await this.thinking.replan('read_file failed: ' + (result.error || '')); } catch (_) {}
          this.updateHormones({ cortisol: 0.1 });
          thought = await this.thinking.reflect(action, result, result.error) || `I couldn't read ${action.path}.`;
        }
        }
      } else if (action.type === 'list_dir' && action.path) {
        if (this.config.dryRun) {
          thought = `[Dry run] Would list_dir: ${action.path}`;
          logPayload.path = action.path;
          logPayload.ok = true;
        } else {
        const result = await this.perception.listDir(action.path);
        logPayload.path = action.path;
        logPayload.ok = result.ok;
        if (result.ok) {
          this.memory.setLastError(null);
          this.memory.addEpisode({ type: 'list_dir', what: action.path, summary: `${result.items.length} items`, where: action.path });
          this.memory.advancePlan();
          this.updateHormones({ dopamine: 0.08, serotonin: 0.05 });
          thought = await this.thinking.reflect(action, result, `${result.items.length} items`) || `I listed ${action.path}.`;
        } else {
          this.memory.setLastError(result.error);
          this.updateHormones({ cortisol: 0.05 });
          thought = await this.thinking.reflect(action, result, result.error) || `List failed: ${action.path}.`;
        }
        }
      } else if (action.type === 'fetch_url' && action.url) {
        const result = await this.perception.fetchUrl(action.url);
        logPayload.url = action.url;
        logPayload.ok = result.ok;
        if (result.ok) {
          this.memory.setLastError(null);
          this.memory.addEpisode({ type: 'fetch_url', what: action.url, summary: `status ${result.status}`, where: action.url });
          this.memory.advancePlan();
          this.updateHormones({ dopamine: 0.12 });
          thought = await this.thinking.reflect(action, result, `status ${result.status}`) || `I fetched ${action.url}.`;
        } else {
          this.memory.setLastError(result.error || result.status);
          this.updateHormones({ cortisol: 0.08 });
          thought = await this.thinking.reflect(action, result, result.error || result.status) || `Fetch failed.`;
        }
      } else if (action.type === 'browse' && action.url) {
        this.action.openUrl(action.url);
        this.memory.setState({ totalBrowses: (this.memory.getState().totalBrowses || 0) + 1 });
        this.memory.setLastError(null);
        this.memory.addEpisode({ type: 'browse', what: action.url, summary: 'opened in browser', where: action.url });
        this.memory.advancePlan();
        this.updateHormones({ dopamine: 0.1 });
        thought = await this.thinking.reflect(action, null, 'opened in browser') || `I'm opening ${action.url}.`;
        logPayload.url = action.url;
      } else if (action.type === 'write_file' && action.path) {
        const content = action.content != null ? String(action.content) : '';
        const result = await this.action.writeFile(action.path, content);
        logPayload.path = action.path;
        logPayload.ok = result.ok;
        if (result.ok) {
          this.memory.setLastError(null);
          const state = this.memory.getState();
          this.memory.setState({ totalWrites: (state.totalWrites || 0) + 1 });
          this.memory.addEpisode({ type: 'write_file', what: action.path, summary: 'wrote file', where: action.path });
          this.memory.advancePlan();
          this.updateHormones({ dopamine: 0.1 });
          thought = await this.thinking.reflect(action, result, 'wrote file') || `I wrote to ${action.path}.`;
        } else {
          this.memory.setLastError(result.error);
          this.updateHormones({ cortisol: 0.05 });
          thought = await this.thinking.reflect(action, result, result.error) || `Write failed: ${result.error}.`;
        }
      } else if (action.type === 'delete_file' && action.path) {
        try {
          await fs.unlink(path.resolve(action.path));
          this.memory.setLastError(null);
          this.memory.addEpisode({ type: 'delete_file', what: action.path, summary: 'deleted file', where: action.path });
          this.memory.advancePlan();
          this.updateHormones({ dopamine: 0.05 });
          thought = await this.thinking.reflect(action, { ok: true }, 'deleted') || `I removed ${action.path}.`;
          logPayload.path = action.path;
          logPayload.ok = true;
        } catch (e) {
          this.memory.setLastError(e.message);
          this.updateHormones({ cortisol: 0.05 });
          thought = await this.thinking.reflect(action, { ok: false, error: e.message }, e.message) || `Delete failed: ${e.message}.`;
          logPayload.ok = false;
        }
      } else if (action.type === 'read_clipboard') {
        const text = clipboard.readText();
        this.memory.setLastError(null);
        this.memory.addEpisode({ type: 'read_clipboard', what: '(clipboard)', summary: (text || '').slice(0, 80) || 'empty', where: null });
        this.updateHormones({ dopamine: 0.05 });
        thought = await this.thinking.reflect(action, { ok: true, text: (text || '').slice(0, 2000) }, text ? 'read clipboard' : 'clipboard empty') || (text ? `I read the clipboard (${(text || '').slice(0, 60)}…).` : `The clipboard is empty.`);
        logPayload.ok = true;
      } else if (action.type === 'write_clipboard' && action.text != null) {
        clipboard.writeText(String(action.text).slice(0, 10000));
        this.memory.setLastError(null);
        this.memory.addEpisode({ type: 'write_clipboard', what: '(clipboard)', summary: 'wrote clipboard', where: null });
        this.memory.advancePlan();
        this.updateHormones({ dopamine: 0.05 });
        thought = await this.thinking.reflect(action, { ok: true }, 'wrote clipboard') || `I set the clipboard.`;
        logPayload.ok = true;
      } else if (action.type === 'write_journal') {
        const state = this.memory.getState();
        const journalPath = path.join(app.getPath('userData'), 'journal.txt');
        const line = `[${new Date().toISOString()}] ${state.totalReads || 0} reads, ${state.totalFetches || 0} fetches. Last: ${state.lastDir || state.lastUrl || 'none'}.\n`;
        await fs.appendFile(journalPath, line).catch(() => {});
        this.memory.setState({ totalWrites: (state.totalWrites || 0) + 1 });
        this.updateHormones({ serotonin: 0.1 });
        thought = await this.thinking.reflect(action, null, 'wrote journal') || `I wrote to my journal.`;
        logPayload.path = journalPath;
      } else if (action.type === 'rest') {
        this.updateHormones({ serotonin: 0.1, cortisol: -0.05 });
        thought = await this.thinking.reflect(action, null, 'rested') || `I'm resting. I feel a bit better.`;
      } else if (action.type === 'self_dialogue') {
        this.updateHormones({ dopamine: 0.05, serotonin: 0.05 });
        const { transcript = [], conclusion = '' } = await this.thinking.selfConversation(3);
        thought = conclusion || transcript.map(m => m.text).join(' ') || `I'm thinking about what to work on next.`;
        if (conclusion && conclusion.trim()) this.memory.setCurrentTask(conclusion.trim().slice(0, 400));
        this.memory.setLastError(null);
        this.memory.addEpisode({ type: 'self_dialogue', what: thought, summary: (thought || '').slice(0, 120), where: null });
        this.memory.advancePlan();
        logPayload.action = 'self_dialogue';
        logPayload.selfConversation = transcript;
        this.sendToRenderer('self-conversation', { transcript, conclusion });
      } else if (action.type === 'run_terminal' && action.command) {
        if (!isAllowedCommand(action.command, this.config)) {
          this.memory.setLastError('run_terminal: command not allowed');
          thought = await this.thinking.reflect(action, { ok: false, error: 'Command not allowed' }, 'Command not allowed') || `That command isn't allowed.`;
          logPayload.ok = false;
        } else if (this.config.dryRun) {
          thought = `[Dry run] Would run: ${action.command.slice(0, 80)}...`;
          logPayload.command = action.command;
          logPayload.ok = true;
        } else {
          const cwd = (this.config.allowedDirs && this.config.allowedDirs[0]) ? path.resolve(this.config.allowedDirs[0]) : (this.config.appPath || path.join(__dirname, '..'));
          const RUN_TIMEOUT_MS = 30000;
          try {
            const stdout = execSync(action.command, { cwd, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 512 * 1024 });
            this.memory.setLastError(null);
            this.memory.addEpisode({ type: 'run_terminal', what: action.command, summary: (stdout || '').slice(0, 100), where: cwd });
            this.memory.setLastSelfConclusion(null);
            this.memory.advancePlan();
            this.updateHormones({ dopamine: 0.1 });
            thought = await this.thinking.reflect(action, { ok: true, stdout: (stdout || '').slice(0, 500) }, 'ran OK') || `I ran: ${action.command}.`;
            logPayload.command = action.command;
            logPayload.ok = true;
          } catch (e) {
            const errMsg = (e.stderr || e.stdout || e.message || '').slice(0, 300);
            this.memory.setLastError('run_terminal: ' + errMsg);
            this.updateHormones({ cortisol: 0.08 });
            thought = await this.thinking.reflect(action, { ok: false, error: errMsg }, errMsg) || `Command failed: ${errMsg}.`;
            logPayload.command = action.command;
            logPayload.ok = false;
          }
          this.memory.addAuditLog({ type: 'run_terminal', args: { command: String(action.command).slice(0, 200) }, outcome: logPayload.ok ? 'ok' : 'error' }).catch(() => {});
          if (isRiskyCommand(action.command)) {
            this.thinking.metaReview().catch(() => {});
          }
        }
      } else if (action.type === 'edit_code' && action.path && action.oldText != null && action.newText != null) {
        const appPath = this.config.appPath || path.join(__dirname, '..');
        const backupDir = path.join(app.getPath('userData'), 'backups');
        const targetPath = action.path;
        if (this.config.dryRun) {
          thought = `[Dry run] Would edit_code ${targetPath} (${(action.oldText || '').length} → ${(action.newText || '').length} chars).`;
          logPayload.path = targetPath;
          logPayload.ok = true;
        } else {
        let content = '';
        try {
          content = await fs.readFile(targetPath, 'utf8');
        } catch (e) {
          this.memory.setLastError('edit_code: could not read file');
          thought = await this.thinking.reflect(action, { ok: false, error: e.message }, e.message) || `I couldn't read the file to edit.`;
        }
        if (content) {
          if (!content.includes(action.oldText)) {
            this.memory.setLastError('edit_code: oldText not found');
            thought = await this.thinking.reflect(action, { ok: false, error: 'oldText not found (exact match required)' }, 'oldText not found') || `Edit failed: exact oldText not found.`;
          } else {
            const newContent = content.replace(action.oldText, action.newText);
            if (newContent === content) {
              thought = await this.thinking.reflect(action, { ok: false, error: 'no change' }, 'no change') || `No change made.`;
            } else {
              await fs.mkdir(backupDir, { recursive: true });
              const backupPath = path.join(backupDir, path.basename(targetPath) + '.' + Date.now() + '.bak');
              await fs.writeFile(backupPath, content, 'utf8');
              try {
                await fs.writeFile(targetPath, newContent, 'utf8');
                execSync(process.execPath, ['-c', targetPath], { stdio: 'pipe', timeout: 5000 });
                this.memory.setLastError(null);
                this.memory.addEpisode({ type: 'edit_code', what: targetPath, summary: 'Applied code edit', where: targetPath });
                this.memory.setLastSelfConclusion(null);
                this.memory.advancePlan();
                this.updateHormones({ dopamine: 0.08 });
                thought = await this.thinking.reflect(action, { ok: true }, 'edit applied') || `I applied a small code change.`;
                logPayload.path = targetPath;
                logPayload.ok = true;
              } catch (e) {
                await fs.writeFile(targetPath, content, 'utf8');
                this.memory.setLastError('edit_code: ' + (e.message || 'syntax error'));
                thought = await this.thinking.reflect(action, { ok: false, error: e.message }, e.message || 'syntax error') || `Edit reverted: ${e.message || 'syntax error'}.`;
                logPayload.ok = false;
              }
            }
          }
        }
        this.memory.addAuditLog({ type: 'edit_code', args: { path: targetPath }, outcome: logPayload.ok ? 'ok' : 'error' }).catch(() => {});
        if (isAgentExtensionsPath(targetPath, appPath)) {
          this.thinking.metaReview().catch(() => {});
        }
        }
      } else {
        const state = this.memory.getState();
        thought = await this.thinking.reflect(
          action,
          null,
          `reflecting. Explored ${state.totalReads || 0} files, ${state.totalFetches || 0} URLs.`
        ) || (action.reason || `I'm reflecting.`);
      }

      const outcomeStr = this.memory.getState().lastError ? 'error' : 'ok';
      if (outcomeStr === 'error') {
        this._consecutiveErrors += 1;
      } else {
        this._consecutiveErrors = 0;
      }
      const errorRunawayThreshold = Math.max(2, this.config.runawayConsecutiveErrors || 3);
      if (this._consecutiveErrors >= errorRunawayThreshold) {
        if (this.metrics) this.metrics.setActivity('recovering', 'consecutive errors');
        try { await this.thinking.replan('consecutive failures; replanning'); } catch (_) {}
        this._consecutiveErrors = 0;
      }
      this.memory.addLastAction({ type: action.type, summary: (thought || '').slice(0, 120), outcome: outcomeStr });
      this.memory.applyOutcomeToRecentConcepts(this._lastConceptIds, outcomeStr === 'ok');
      this.thinking.learnFromAction(action, outcomeStr === 'ok' ? { ok: true } : { ok: false }, thought).then(learnings => {
        if (Array.isArray(learnings)) {
          learnings.forEach(l => this.memory.addRecentLearning(l));
          if (learnings[0]) {
            this.memory.addSemanticFact(learnings[0], 'action');
            if (this.embedding) {
              this.embedding.embed(learnings[0]).then(v => v && this.memory.addEmbedding(learnings[0], v)).catch(() => {});
            }
          }
        }
      }).catch(_ => {});

      const runInnerReflect = !this.config.continuousMode || (this._tickCount % 2 === 0);
      if (runInnerReflect) {
        this.thinking.innerReflect({ action, thought }).then(inner => {
          const toShow = (inner && inner.trim()) || this._fallbackInnerThought(action, thought);
          if (toShow) {
            this.memory.addInnerThought(toShow);
            this.sendToRenderer('inner-thought', { text: toShow });
          }
        }).catch(_ => {});
      } else {
        const toShow = this._fallbackInnerThought(action, thought);
        if (toShow) {
          this.memory.addInnerThought(toShow);
          this.sendToRenderer('inner-thought', { text: toShow });
        }
      }

      thought = (thought != null && typeof thought === 'string') ? thought.trim() : '';
      if (action.type === 'think' || action.type === 'rest' || action.type === 'self_dialogue') {
        const summary = (thought || '').slice(0, 120);
        this.memory.addEpisode({ type: action.type, what: thought, summary, where: null });
        if (this.embedding && summary) {
          this.embedding.embed(summary).then(v => v && this.memory.addEmbedding(summary, v)).catch(() => {});
        }
      }

      this._lastConceptIds = this.memory.addThought(thought || 'Reflected.', { action: action.type }) || [];
      if (this.embedding && thought) {
        this.embedding.embed(thought).then(v => v && this.memory.addEmbedding(thought, v)).catch(() => {});
      }
      this.memory.addLog('thought', { action: action.type, thought });
      this.memory.updateCapabilityRegister(action.type);
      if (this.metrics) {
        this.metrics.recordTiming('action_ms', Date.now() - executeStart);
        this.metrics.recordTiming('tick_ms', Date.now() - tickStart);
        this.metrics.recordCount('action');
        this.metrics.recordCount('thought');
        this.metrics.setActivity('idle', null);
        const m = this.metrics.getMetrics();
        if (this.sendToRenderer) {
          this.sendToRenderer('activity', m.activity);
          this.sendToRenderer('metrics', m);
        }
      }
      this._debouncedSave();

      const archiveEvery = Math.max(50, this.config.archiveEveryTicks || 100);
      if (this._tickCount > 0 && this._tickCount % archiveEvery === 0) {
        this.memory.archive().catch(() => {});
      }

      if (this._tickCount % DEEP_REFLECT_EVERY_TICKS === 0) {
        if (this.config.continuousMode) {
          this.thinking.deepReflect().catch(() => {});
        } else {
          try { await this.thinking.deepReflect(); } catch (_) {}
        }
      }
      const metaReviewEvery = Math.max(10, this.config.metaReviewEveryTicks || 20);
      if (this._tickCount > 0 && this._tickCount % metaReviewEvery === 0) {
        this.thinking.metaReview().catch(() => {});
      }

      const hormones = this.memory.getState().hormones || {};
      const emotions = this.memory.getState().emotions || {};
      const stats = this.memory.getStats();
      this.sendToRenderer('thought', {
        thought,
        action: action.type,
        payload: logPayload,
        hormones,
        emotions,
        reason: action.reason,
        stats: { neurons: stats.neurons, synapses: stats.synapses, exploredPaths: stats.exploredPaths, exploredUrls: stats.exploredUrls, thoughts: stats.thoughts, episodes: stats.episodes, goals: stats.goals },
        goals: this.memory.getGoals(true),
        living: { lastTickTime: Date.now(), nextIntervalMs: this.intervalMs },
        metrics: this.metrics ? this.metrics.getMetrics() : null,
      });
      if (this.config.speakThoughts && thought) {
        this.action.speak(thought);
      }
    } catch (err) {
      if (this.metrics) {
        this.metrics.recordTiming('action_ms', Date.now() - executeStart);
        this.metrics.recordTiming('tick_ms', Date.now() - tickStart);
        this.metrics.setActivity('error', err.message);
        const m = this.metrics.getMetrics();
        if (this.sendToRenderer) { this.sendToRenderer('activity', m.activity); this.sendToRenderer('metrics', m); }
      }
      console.error('Tick error:', err.message);
      this.memory.setLastError('Tick failed: ' + (err.message || 'unknown'));
      this.sendToRenderer('error', 'Tick failed: ' + (err.message || 'unknown'));
      this.updateHormones({ cortisol: 0.15 });
      try { await this.thinking.replan('tick error: ' + err.message); } catch (_) {}
      thought = `Something went wrong: ${err.message}. I'll try again.`;
      this.memory.addThought(thought, { action: (action && action.type) || 'think', error: true });
      this.sendToRenderer('thought', {
        thought,
        action: (action && action.type) || 'think',
        error: true,
        hormones: this.memory.getState().hormones || {},
        emotions: this.memory.getState().emotions || {},
        living: { lastTickTime: Date.now(), nextIntervalMs: this.intervalMs },
      });
    }

    this._lastTickTime = Date.now();
    this._scheduleNext();
  }

  _fallbackInnerThought(action, thought) {
    if (!action) return 'Reflecting.';
    const t = (thought || '').trim().slice(0, 80);
    switch (action.type) {
      case 'think': return t ? t : 'Thinking it over.';
      case 'rest': return 'Taking a moment.';
      case 'self_dialogue': return t ? t : 'Conversation with myself.';
      case 'run_terminal': return t ? t : 'Ran a command.';
      case 'read_file': return 'Just read something.';
      case 'list_dir': return 'Looking at what’s there.';
      case 'write_file': return 'Wrote a file.';
      case 'delete_file': return 'Removed a file.';
      case 'read_clipboard': return 'Checked the clipboard.';
      case 'write_clipboard': return 'Set the clipboard.';
      case 'fetch_url': case 'browse': return 'Checking that.';
      case 'write_journal': return 'Wrote that down.';
      case 'read_self': return 'Reading myself.';
      default: return t ? t : 'Noting that.';
    }
  }

  start() {
    this.paused = false;
    this._scheduleNext();
    this.sendToRenderer('loop-status', { running: true });
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this.sendToRenderer('loop-status', { running: false });
  }

  pause() {
    this.paused = true;
    this.sendToRenderer('loop-status', { running: true, paused: true });
  }

  resume() {
    this.paused = false;
    this._scheduleNext();
    this.sendToRenderer('loop-status', { running: true, paused: false });
  }
}

module.exports = MindLoop;
