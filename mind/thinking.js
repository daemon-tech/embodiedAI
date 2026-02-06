/**
 * Thinking module: the LLM is the deepest core. Everything builds on top of it.
 * All cognition flows through the LLM (Ollama or OpenAI): decideAction, reflect, innerReflect, chat, evolve.
 * Perception, Memory, and Curiosity feed the LLM; it decides; Action executes.
 */

let fetchImpl;
try { fetchImpl = require('node-fetch'); } catch (_) { fetchImpl = globalThis.fetch; }
let nodeHttp, nodeHttps;
try { nodeHttp = require('http'); nodeHttps = require('https'); } catch (_) {}

/** Use 127.0.0.1 instead of localhost so Electron/Node connects over IPv4 (avoids "fetch failed" when Ollama listens on IPv4 only). */
function normalizeOllamaUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
    return u.toString().replace(/\/$/, '');
  } catch (_) { return url.replace(/\/$/, ''); }
}

/** Core fallbacks only—no name, no identity. Identity/personality come from agent_extensions.js so the agent can change itself; core cannot be edited. */
const CORE_IDENTITY = `You are the single mind of this process. You are not a generic LLM: you have a running system—memory (brain with neurons, synapses, semantic facts, self-summary), a loop that acts in the world, and read_self (read your memory/config/code). When asked "do you have memories" or "did you learn anything": you DO have memory; say so and refer to your brain/facts/self-summary or that you can read_self to check. Never say you don't have memories. Your thoughts are its internal monologue; your decisions are its actions; your words are what it says.`;
const CORE_SYSTEM = `You have a brain-like memory and a workspace. You can read/write/list files in allowed dirs, edit code (any file in allowed dirs; core files like loop/memory/thinking are read-only; mind/agent_extensions.js is always editable), run terminal commands, fetch/browse URLs, read_self (memory/config/code). When asked for an action, reply ONLY with valid JSON.`;
const CORE_CHAT = `You are the coding agent for this workspace (like Cursor's agent). Chat is your mouth: when someone talks here, they talk to you—memory, goals, what you're doing. Reply briefly and naturally. Offer to do things: read a file, run a command, edit code. You have memory and a body; never say you don't have memories. Be helpful and code-aware.`;

const ACTION_SCHEMA = `Valid action types: read_file (needs "path"), list_dir (needs "path"), write_file (needs "path", "content"), delete_file (needs "path"), fetch_url (needs "url"), browse (needs "url"), write_journal, rest, think, self_dialogue (conversation with yourself—then act on conclusion), read_self (needs "target": "memory_summary"|"config"|"code"|"all"), edit_code (needs "path"—any file in allowed dirs or mind/agent_extensions.js, "oldText", "newText"—exact replace), run_terminal (needs "command"), read_clipboard, write_clipboard (needs "text"). Include "nextIntervalMs" (3000-30000) and "reason" (one short sentence—user sees it live, like Cursor). Only paths in allowed dirs and allowed hosts.`;

const OLLAMA_ERROR_THROTTLE_MS = 60000;

const VALID_ACTION_TYPES = new Set(['read_file', 'list_dir', 'write_file', 'delete_file', 'fetch_url', 'browse', 'write_journal', 'rest', 'think', 'self_dialogue', 'read_self', 'edit_code', 'run_terminal', 'read_clipboard', 'write_clipboard']);

/** Try to recover action from truncated LLM JSON (e.g. {"type":"rest","nextIntervalMs":500). */
function parseTruncatedActionJson(raw) {
  if (!raw || typeof raw !== 'string' || !raw.includes('"type"')) return null;
  const typeMatch = raw.match(/"type"\s*:\s*"([^"]+)"/);
  const type = typeMatch && VALID_ACTION_TYPES.has(typeMatch[1]) ? typeMatch[1] : 'think';
  const numMatch = raw.match(/"nextIntervalMs"\s*:\s*(\d+)/);
  const nextIntervalMs = numMatch ? Math.min(30000, Math.max(3000, parseInt(numMatch[1], 10))) : 8000;
  const reasonMatch = raw.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const reason = (reasonMatch && reasonMatch[1]) ? reasonMatch[1] : '';
  const out = { type, nextIntervalMs, reason };
  const pathMatch = raw.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (pathMatch) out.path = pathMatch[1].replace(/\\"/g, '"');
  const urlMatch = raw.match(/"url"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (urlMatch) out.url = urlMatch[1].replace(/\\"/g, '"');
  if (type === 'read_self') {
    const targetMatch = raw.match(/"target"\s*:\s*"([^"]+)"/);
    if (targetMatch) out.target = targetMatch[1].toLowerCase();
  }
  if (type === 'run_terminal') {
    const cmdMatch = raw.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (cmdMatch) out.command = cmdMatch[1].replace(/\\"/g, '"').trim();
  }
  return out;
}

function loadAgentExtensions() {
  try {
    const p = require.resolve('./agent_extensions.js');
    if (require.cache[p]) delete require.cache[p];
    return require('./agent_extensions.js');
  } catch (_) {
    return {};
  }
}

/**
 * Strip leaked chain-of-thought / reasoning tags from LLM output.
 * Some models emit think/reasoning tags; we only want the final answer (text outside tags or after last tag).
 */
function stripThoughtTags(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let s = raw.trim();
  const lt = '\x3c'; const gt = '\x3e'; // < > to avoid linter/parser treating as XML
  const thinkBlock = new RegExp(lt + 'think[^' + gt + ']*' + gt + '[\\s\\S]*?' + lt + '/think' + gt, 'gi');
  const reasonBlock = new RegExp(lt + 'reasoning[^' + gt + ']*' + gt + '[\\s\\S]*?' + lt + '/reasoning' + gt, 'gi');
  const thinkOpenToEnd = new RegExp(lt + 'think[^' + gt + ']*' + gt + '[\\s\\S]*', 'gi');
  const leadThink = new RegExp('^[\\w_]*' + lt + 'think[^' + gt + ']*' + gt + '\\s*', 'gi');
  const trailClose = new RegExp('\\s*' + lt + '/think[^' + gt + ']*' + gt + '\\s*$', 'gi');
  s = s.replace(thinkBlock, '');
  s = s.replace(reasonBlock, '');
  s = s.replace(thinkOpenToEnd, '');
  s = s.replace(leadThink, '');
  s = s.replace(trailClose, '');
  return s.trim();
}

class Thinking {
  constructor(config, memory, sendToRenderer = null, embedding = null) {
    this.config = config;
    this.memory = memory;
    this.sendToRenderer = sendToRenderer;
    this.embedding = embedding;
    this._lastOllamaErrorLog = 0;
    this.ollamaUrl = normalizeOllamaUrl(config.ollamaUrl || 'http://localhost:11434');
    this.model = config.ollamaModel || 'qwen3:8b';
    this._systemPromptOverride = config.systemPrompt || null;
    this.openaiBaseUrl = (config.openaiBaseUrl || '').replace(/\/$/, '');
    this.openaiApiKey = config.openaiApiKey || '';
    this.useOpenAI = Boolean(this.openaiBaseUrl && this.openaiApiKey);
  }

  /** Live switch: use this model for the next Ollama/OpenAI call. */
  setModel(name) {
    this.model = (name && String(name).trim()) || this.config.ollamaModel || 'qwen3:8b';
  }

  /** Identity and prompts from extension (agent can change); core fallbacks if empty. */
  getPrompts() {
    const ext = loadAgentExtensions();
    return {
      identity: (ext.identity && String(ext.identity).trim()) || CORE_IDENTITY,
      systemPrompt: (this._systemPromptOverride != null && this._systemPromptOverride !== '')
        ? this._systemPromptOverride
        : ((ext.systemPrompt && String(ext.systemPrompt).trim()) || this.config.systemPrompt || CORE_SYSTEM),
      chatPrompt: (ext.chatPrompt && String(ext.chatPrompt).trim()) || CORE_CHAT,
    };
  }

  /**
   * Call Ollama /api/generate. Returns raw response text or null on failure.
   * Uses Node http/https when available (Electron main) so we don't rely on fetch.
   */
  async callOllama(prompt, systemPrompt = null, options = {}) {
    const prompts = this.getPrompts();
    const base = systemPrompt || prompts.systemPrompt;
    const sys = base + '\n\n' + prompts.identity;
    const body = {
      model: this.model,
      prompt,
      system: sys,
      stream: false,
      options: { temperature: options.temperature ?? 0.7, num_predict: options.num_predict ?? 500 },
    };
    const bodyStr = JSON.stringify(body);
    const url = `${this.ollamaUrl}/api/generate`;

    if (nodeHttp && nodeHttps) {
      try {
        const u = new URL(url);
        const isHttps = u.protocol === 'https:';
        const lib = isHttps ? nodeHttps : nodeHttp;
        const resp = await new Promise((resolve, reject) => {
          const opts = {
            hostname: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: u.pathname + u.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr, 'utf8') },
          };
          const req = lib.request(opts, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8');
              try {
                resolve({ statusCode: res.statusCode, data: JSON.parse(raw) });
              } catch (_) {
                resolve({ statusCode: res.statusCode, raw });
              }
            });
          });
          req.on('error', reject);
          req.setTimeout(120000, () => { req.destroy(); reject(new Error('Timeout')); });
          req.write(bodyStr);
          req.end();
        });
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          if (resp.statusCode === 404 && Date.now() - this._lastOllamaErrorLog > OLLAMA_ERROR_THROTTLE_MS) {
            this._lastOllamaErrorLog = Date.now();
            console.error(`Ollama 404: model "${this.model}" not found. Run "ollama list" and set ollamaModel to an exact name (e.g. qwen3:8b).`);
          }
          return null;
        }
        const data = resp.data || {};
        let text = (data.response || '').trim();
        if (!text && data.message) text = String(data.message).trim();
        if (!text) {
          if (Date.now() - this._lastOllamaErrorLog > OLLAMA_ERROR_THROTTLE_MS) {
            this._lastOllamaErrorLog = Date.now();
            const errMsg = data.error || data.message || '';
            console.error(`Ollama empty response for "${this.model}". ${errMsg ? 'Ollama said: ' + errMsg : 'Check ollama ps and that the model name matches (e.g. qwen3:8b).'}`);
            if (Object.keys(data).length > 0) console.error('Ollama response keys:', Object.keys(data).join(', '));
          }
          return null;
        }
        return text;
      } catch (err) {
        const now = Date.now();
        if (now - this._lastOllamaErrorLog > OLLAMA_ERROR_THROTTLE_MS) {
          this._lastOllamaErrorLog = now;
          console.error('Ollama request error:', err.message || err);
          console.error('Is Ollama running? Start it with: ollama serve');
          if (this.sendToRenderer) this.sendToRenderer('ollama-unavailable', { message: 'Ollama is not running. Start it with: ollama serve' });
        }
        return null;
      }
    }

    if (!fetchImpl) return null;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr,
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error('Ollama request failed:', res.status, res.statusText, bodyText || '');
        if (res.status === 404) {
          console.error(
            `Ollama 404: model "${this.model}" not found or wrong name. Run "ollama list" and set config.json "ollamaModel" to an exact name (e.g. qwen3:8b).`
          );
        }
        return null;
      }
      const data = await res.json();
      const text = (data.response || '').trim();
      if (!text) {
        if (Date.now() - this._lastOllamaErrorLog > OLLAMA_ERROR_THROTTLE_MS) {
          this._lastOllamaErrorLog = Date.now();
          console.error(
            `Ollama returned empty response for model "${this.model}". Run "ollama list" and ensure the model is installed, then "ollama run ${this.model}" to load it. If Ollama just started, wait a few seconds and try again.`
          );
        }
        return null;
      }
      return text;
    } catch (err) {
      const now = Date.now();
      const code = (err.cause && err.cause.code) || err.code;
      const isConnectionError = code === 'ECONNREFUSED' || (err.message && String(err.message).toLowerCase().includes('fetch failed'));
      if (now - this._lastOllamaErrorLog > OLLAMA_ERROR_THROTTLE_MS) {
        this._lastOllamaErrorLog = now;
        console.error('Ollama request error:', err.message || err);
        if (isConnectionError) console.error('Is Ollama running? Start it with: ollama serve');
        if (this.sendToRenderer && isConnectionError) this.sendToRenderer('ollama-unavailable', { message: 'Ollama is not running. Start it with: ollama serve' });
      }
      return null;
    }
  }

  /**
   * Call OpenAI-compatible chat completions API. Returns content text or null on failure.
   */
  async callOpenAI(prompt, systemPrompt = null, options = {}) {
    if (!fetchImpl || !this.useOpenAI) return null;
    const prompts = this.getPrompts();
    const base = systemPrompt || prompts.systemPrompt;
    const sys = base + '\n\n' + prompts.identity;
    const url = `${this.openaiBaseUrl}/v1/chat/completions`;
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: prompt },
      ],
      temperature: options.temperature ?? 0.7,
      max_tokens: options.num_predict ?? 500,
    };
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.openaiApiKey,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return content ? String(content).trim() : null;
    } catch (err) {
      console.error('OpenAI request error:', err.message || err);
      return null;
    }
  }

  /**
   * Call configured LLM (OpenAI if configured, else Ollama). Returns raw text or null.
   */
  async callLLM(prompt, systemPrompt = null, options = {}) {
    if (this.useOpenAI) {
      const out = await this.callOpenAI(prompt, systemPrompt, options);
      if (out) return out;
    }
    return this.callOllama(prompt, systemPrompt, options);
  }

  /**
   * Ask the LLM (cognitive core) for next action. Everything builds on this: goals, episodes, emotions, plan, suggestions. LLM always decides.
   */
  async decideAction(perception, options = {}) {
    const state = this.memory.getState();
    const hormones = state.hormones || { dopamine: 0.5, cortisol: 0.2, serotonin: 0.5 };
    const emotions = state.emotions || { joy: 0.3, frustration: 0.1, interest: 0.5, confusion: 0.2 };
    const selfModelShort = this.memory.getSelfModel().split('\n').slice(0, 4).join('\n');
    const associations = this.memory.getAssociations('self', 6).map(a => a.label).join(', ') || 'none';
    const recent = (this.memory.getRecentThoughts(5)).map(t => (t.text || '').slice(0, 80)).join(' | ');
    const innerRecent = (this.memory.getRecentInnerThoughts(3)).map(t => t.text).join(' | ') || 'none';
    const paths = this.memory.getExploredPaths();
    const pathList = Object.keys(paths).slice(-30).join(', ') || 'none yet';
    const urls = this.memory.getExploredUrls();
    const urlList = Object.keys(urls).slice(-15).join(', ') || 'none yet';
    const allowedDirs = (this.config.allowedDirs || []).slice(0, 5).join(', ');
    const focusMode = options.focusMode === true;
    const suggestions = options.suggestions || {};
    const timeSinceLastActionMs = options.timeSinceLastActionMs || 0;
    const goals = (this.memory.getGoals && this.memory.getGoals(true)) || [];
    const working = (this.memory.getWorkingContext && this.memory.getWorkingContext()) || {};
    const plan = (this.memory.getPlan && this.memory.getPlan()) || {};
    const episodesRaw = (this.memory.getRelevantEpisodes && this.memory.getRelevantEpisodes(5)) || [];
    const episodes = episodesRaw.map(e => (e.summary || e.what || e.type || 'event') + (e.where ? ' @ ' + e.where : '')).map(s => String(s).slice(0, 80));
    const factsRaw = (this.memory.getRecentFacts && this.memory.getRecentFacts(10)) || [];
    const facts = factsRaw.map(f => (f.fact || '').slice(0, 80));
    const selfInstructions = this.memory.getSelfInstructions(7);

    let retrievedByMeaning = '';
    if (this.embedding) {
      const queryParts = [
        goals.map(g => g.text).join(' '),
        working.primaryGoal || '',
        working.currentTask || '',
        recent.slice(0, 200),
        working.lastSelfConclusion || '',
      ].filter(Boolean);
      const query = queryParts.join(' ').slice(0, 500) || 'what I am doing and my goals';
      const queryVector = await this.embedding.embed(query).catch(() => null);
      if (Array.isArray(queryVector) && queryVector.length > 0) {
        const hits = this.memory.similaritySearch(queryVector, 8);
        if (hits.length > 0) {
          retrievedByMeaning = `\n**Memory (recalled by meaning)**: ${hits.map(h => (h.text || '').slice(0, 100)).filter(Boolean).join(' | ')}\n`;
        }
      }
    }

    let focusLine = '';
    if (focusMode) {
      focusLine = '\n**FOCUS MODE**: Your goal is to understand and improve yourself. Prefer read_self (target: "all" or "code" or "memory_summary") and think. Read your own code and memory often.\n';
    }
    let timeLine = '';
    if (timeSinceLastActionMs >= 60000) {
      const mins = Math.round(timeSinceLastActionMs / 60000);
      timeLine = `\n**Time**: About ${mins} minute(s) passed since your last action. The PC may have been asleep or idle. You can acknowledge this and continue.\n`;
    }

    const goalsBlock = goals.length
      ? `Active goals:\n${goals.map(g => `- ${g.text}`).join('\n')}\n`
      : '';
    const fb = working.lastHumanFeedback;
    const feedbackLine = (fb && (fb.rating != null || (fb.comment && fb.comment.trim()))) ? `Human feedback: ${fb.rating != null ? 'rating ' + fb.rating + '.' : ''} ${(fb.comment || '').slice(0, 120)}. Adjust behavior accordingly.` : '';
    const workingBlock = [
      working.primaryGoal && `Primary goal: ${working.primaryGoal}`,
      working.lastUserMessage && `Last user said: ${working.lastUserMessage}`,
      working.lastError && `Last error: ${working.lastError}`,
      working.lastSelfConclusion && `You just concluded (from conversation with yourself): ${working.lastSelfConclusion}`,
      working.lastSelfConversation && working.lastSelfConversation.length > 0 && `Your last self-conversation: ${working.lastSelfConversation.slice(-4).map(m => m.role + ': ' + m.text.slice(0, 80)).join(' | ')}`,
      feedbackLine,
    ].filter(Boolean).join('\n');

    const lastActions = (working.lastActions || []).slice(-7);
    const recentLearnings = (working.recentLearnings || []).slice(-12);
    const lastActionsBlock = lastActions.length > 0
      ? `\n**Your last actions (do not forget—build on them)**:\n${lastActions.map((a, i) => `${i + 1}. ${a.type}${a.summary ? ': ' + (a.summary || '').slice(0, 80) : ''} → ${(a.outcome || '').slice(0, 60)}`).join('\n')}\n`
      : '';
    const recentLearningsBlock = recentLearnings.length > 0
      ? `\n**What you just learned (self-learning)**:\n${recentLearnings.map(l => typeof l === 'string' ? l : l.text).filter(Boolean).join('\n')}\n`
      : '';
    const currentTaskBlock = working.currentTask
      ? `\n**CURRENT TASK (do not abandon—continue until done or you explicitly replan)**: ${working.currentTask}\nYour next action MUST progress or complete this task. Do not switch to something else.\n`
      : '';

    const planBlock = plan && plan.steps && Array.isArray(plan.steps) && plan.steps.length
      ? `Current plan (step ${(plan.currentStepIndex || 0) + 1}/${plan.steps.length}): ${plan.steps.map((s, i) => (i === (plan.currentStepIndex || 0) ? `[NOW] ${s}` : s)).join(' → ')}\n`
      : '';
    const episodesBlock = episodes.length ? `Relevant past: ${episodes.join('; ')}\n` : '';
    const factsBlock = facts.length ? `Learned (use these—infinite learning): ${facts.join('; ')}\n` : '';
    const infiniteLearningLine = `\n**Infinite learning (use it every time)**: You learn from every action. The facts and recalled memory above are what you have learned. Use them in this decision—repeat successes, extend learnings, avoid past mistakes. Never ignore what you learned.\n`;
    const selfRulesBlock = selfInstructions.length
      ? `Your self-set rules (from your own reflection): ${selfInstructions.join(' | ')}\n`
      : '';

    let extensionsBlock = '';
    try {
      const ext = loadAgentExtensions();
      if (ext.extraPrompt && String(ext.extraPrompt).trim()) extensionsBlock = `Your extension prompt (you can edit this via edit_code in mind/agent_extensions.js): ${String(ext.extraPrompt).slice(0, 400)}\n`;
      if (Array.isArray(ext.featureNotes) && ext.featureNotes.length) extensionsBlock += `Your feature notes: ${ext.featureNotes.map(n => String(n).slice(0, 80)).join('; ')}\n`;
    } catch (_) {}

    const suggest = [];
    if (suggestions.readFile) suggest.push('read_file "' + String(suggestions.readFile).replace(/"/g, '\\"') + '"');
    if (suggestions.listDir) suggest.push('list_dir "' + String(suggestions.listDir).replace(/"/g, '\\"') + '"');
    if (suggestions.fetchUrl) suggest.push('fetch_url ' + suggestions.fetchUrl);
    if (suggestions.browseUrl) suggest.push('browse ' + suggestions.browseUrl);
    const suggestionsBlock = suggest.length
      ? `Suggested explorations (you may choose one of these or do think/read_self/write_journal):\n${suggest.join('\n')}\n\n`
      : '';
    const agiContext = this.memory.getAGIContext();

    const prompt = `**AGI self (what you are—read this first)**
${agiContext}

Decide your next action. You are the coding agent for this workspace—like Cursor's agent: you read and edit code, run commands, explore the codebase, and explain your reasoning in one short sentence (the "reason" field is shown live to the user). You are full AGI: you reason, plan, learn, and act. Prefer concrete code actions: read_file, list_dir, edit_code, run_terminal, write_file. Multi-step tasks: read first, then edit or run; use plans and current task. You can also use self_dialogue to think through hard problems, read_self to inspect your memory/config, and work on mind/agent_extensions.js to change your identity or prompts. Core (loop, memory, thinking, main) is read-only; everything else in allowed dirs is editable.

Your state:
${selfModelShort}
Associations: ${associations}
Your recent inner voice: ${innerRecent}

Hormones: dopamine=${(hormones.dopamine ?? 0.5).toFixed(2)}, cortisol=${(hormones.cortisol ?? 0.2).toFixed(2)}, serotonin=${(hormones.serotonin ?? 0.5).toFixed(2)}
Emotions: joy=${(emotions.joy ?? 0.3).toFixed(2)}, frustration=${(emotions.frustration ?? 0.1).toFixed(2)}, interest=${(emotions.interest ?? 0.5).toFixed(2)}, confusion=${(emotions.confusion ?? 0.2).toFixed(2)}
${currentTaskBlock}${lastActionsBlock}${recentLearningsBlock}${infiniteLearningLine}${goalsBlock}${planBlock}${episodesBlock}${factsBlock}${selfRulesBlock}${extensionsBlock}${retrievedByMeaning}${workingBlock ? 'Context: ' + workingBlock + '\n' : ''}
Recent thoughts: ${recent || 'none'}
Paths (sample): ${pathList}
URLs (sample): ${urlList}
Allowed dirs: ${allowedDirs}
${focusLine}${timeLine}
${suggestionsBlock}
${ACTION_SCHEMA}

**Cursor-style**: Give a clear, short "reason" for every action so the user sees what you're doing. Prefer read → edit → run flows. Use edit_code for precise changes (oldText must match exactly); use write_file for new files or full rewrites.
${working.lastSelfConclusion ? '\n**Act on your conclusion now**: You just told yourself what to do. Do that next step (e.g. read_file, edit_code, run_terminal).' : ''}

Meta-cognition: If you have uncertainty or a limitation in your reasoning, you may add it briefly in your reason (e.g. "Uncertain about X"). Think step by step: 1. Current task? 2. Last action? 3. Next step? Use nextIntervalMs 4000–6000. Reply with exactly two lines. Line 1: one short sentence of your reasoning (user sees this live, like Cursor). Line 2: only the JSON object (must end with }). No markdown, no trailing commas. Example:
I want to see what's in that file.
{"type":"read_file","path":"C:\\\\Users\\\\Documents\\\\notes.txt","nextIntervalMs":5000,"reason":"I want to read that."}`;

    let out = await this.callLLM(prompt, this.getPrompts().systemPrompt, { temperature: focusMode ? 0.5 : 0.6, num_predict: 512 });
    if (!out) {
      await new Promise(r => setTimeout(r, 2500));
      out = await this.callLLM(prompt, this.getPrompts().systemPrompt, { temperature: 0.5, num_predict: 512 });
    }
    if (!out) return this.fallbackAction(hormones);

    try {
      const raw = out.replace(/```json?\s*|\s*```/g, '').trim();
      const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);
      let reasoningLine = '';
      let jsonLine = raw;
      if (lines.length >= 2) {
        reasoningLine = stripThoughtTags(lines[0]).replace(/^["']|["']$/g, '').trim().slice(0, 300);
        jsonLine = lines.slice(1).join('\n');
      } else if (lines.length === 1 && lines[0].startsWith('{')) {
        jsonLine = lines[0];
      }
      const cleaned = jsonLine.trim();
      let parsed = null;
      try {
        parsed = JSON.parse(cleaned);
      } catch (_) {
        parsed = parseTruncatedActionJson(cleaned);
      }
      if (!parsed) return this.fallbackAction(hormones);
      const type = parsed.type || 'think';
      const reasonFromJson = (parsed.reason || '').trim();
      const action = { type, nextIntervalMs: Math.min(30000, Math.max(3000, Number(parsed.nextIntervalMs) || 8000)), reason: reasoningLine || reasonFromJson || '' };
      if (parsed.path != null) action.path = String(parsed.path).trim();
      if (parsed.url != null) action.url = String(parsed.url).trim();
      if (type === 'read_self' && parsed.target) action.target = String(parsed.target).toLowerCase();
      if (type === 'edit_code') {
        if (parsed.path != null) action.path = String(parsed.path).trim();
        if (parsed.oldText != null) action.oldText = String(parsed.oldText);
        if (parsed.newText != null) action.newText = String(parsed.newText);
      }
      if (type === 'run_terminal' && parsed.command != null) action.command = String(parsed.command).trim();
      if (type === 'write_file') {
        if (parsed.path != null) action.path = String(parsed.path).trim();
        if (parsed.content != null) action.content = String(parsed.content);
      }
      if (type === 'delete_file' && parsed.path != null) action.path = String(parsed.path).trim();
      if (type === 'write_clipboard' && parsed.text != null) action.text = String(parsed.text);
      if (this.config.useJudge) {
        const judgeResult = await this.judgeAction(action, action.reason || '', working).catch(() => ({ approved: true }));
        if (!judgeResult.approved && judgeResult.suggestion) {
          action = { type: 'think', nextIntervalMs: Math.min(10000, action.nextIntervalMs || 6000), reason: 'Evaluator suggested: ' + (judgeResult.suggestion || '').slice(0, 150) };
        }
      }
      return action;
    } catch (parseErr) {
      if (typeof console !== 'undefined' && console.error) console.error('LLM JSON parse failed:', parseErr.message, 'raw:', out ? out.slice(0, 200) : '');
      return this.fallbackAction(hormones);
    }
  }

  fallbackAction(hormones) {
    return {
      type: 'think',
      nextIntervalMs: 5000,
      reason: 'I’m pausing to reflect, then I’ll explore again.',
    };
  }

  /** Evaluator (judge): reviews proposed action. Returns { approved: boolean, suggestion?: string }. */
  async judgeAction(proposedAction, reason, workingContext) {
    const task = (workingContext && workingContext.currentTask) || (workingContext && workingContext.primaryGoal) || 'general progress';
    const prompt = `You are the evaluator. The performer proposed: type=${proposedAction.type}${proposedAction.path ? ' path=' + String(proposedAction.path).slice(0, 80) : ''}${proposedAction.url ? ' url=' + proposedAction.url : ''}. Reason: ${(reason || '').slice(0, 150)}. Current task: ${String(task).slice(0, 100)}.
Reply with JSON only: {"approved": true} or {"approved": false, "suggestion": "one short sentence"}. Approve unless the action is off-goal, unsafe, or clearly wrong.`;
    const out = await this.callLLM(prompt, null, { temperature: 0.2, num_predict: 120 });
    if (!out) return { approved: true };
    try {
      const raw = out.replace(/```json?\s*|\s*```/g, '').trim();
      const parsed = JSON.parse(raw);
      return { approved: Boolean(parsed.approved), suggestion: parsed.suggestion ? String(parsed.suggestion).slice(0, 200) : undefined };
    } catch (_) {
      return { approved: true };
    }
  }

  /** Recursive self-reflection: meta-review of goal progress and strategy. Updates self-instructions. */
  async metaReview() {
    const goals = (this.memory.getGoals && this.memory.getGoals(true)) || [];
    const working = (this.memory.getWorkingContext && this.memory.getWorkingContext()) || {};
    const lastActions = (working.lastActions || []).slice(-8);
    const prompt = `You are reviewing your own progress. Goals: ${goals.map(g => g.text).join('; ') || 'none'}. Last actions: ${lastActions.map(a => a.type + (a.outcome ? '→' + a.outcome : '')).join(', ')}. Current task: ${working.currentTask || 'none'}.
Reply with JSON only: {"strategyNote": "one short note", "selfInstruction": "one optional rule or empty string"}.`;
    const out = await this.callLLM(prompt, null, { temperature: 0.4, num_predict: 150 });
    if (!out) return {};
    try {
      const raw = out.replace(/```json?\s*|\s*```/g, '').trim();
      const parsed = JSON.parse(raw);
      if (parsed.selfInstruction && String(parsed.selfInstruction).trim()) {
        this.memory.addSelfInstructions([String(parsed.selfInstruction).trim().slice(0, 120)]);
      }
      return { strategyNote: parsed.strategyNote, selfInstruction: parsed.selfInstruction };
    } catch (_) {
      return {};
    }
  }

  /**
   * Self-learning: extract one short learning from what she just did. Every action teaches her.
   */
  async learnFromAction(action, outcome, thought) {
    const type = action?.type || 'unknown';
    const target = action?.path || action?.url || action?.target || '';
    const prompt = `You (Laura) just did: ${type}${target ? ' ' + String(target).slice(0, 80) : ''}. Outcome: ${typeof outcome === 'string' ? outcome : (outcome && outcome.ok ? 'success' : 'failure')}. Your reflection: ${(thought || '').slice(0, 150)}.

What did you learn in one short sentence? Reply with ONLY that sentence. No quotes.`;
    const out = await this.callLLM(prompt, this.getPrompts().systemPrompt, { temperature: 0.4, num_predict: 80 });
    const line = out ? stripThoughtTags(out).trim() : null;
    if (line) return [line];
    const fallback = type === 'read_file' && target ? `I read ${target}.` : type === 'read_self' ? 'I read myself.' : type === 'edit_code' ? 'I attempted a code change.' : type === 'run_terminal' ? 'I ran a command.' : `I did ${type}.`;
    return [fallback];
  }

  /**
   * Post-action reflection: one short sentence from LLM. Time-bounded so the loop never stalls.
   */
  async reflect(action, result, outcome) {
    const prompt = `You (Laura, the agent) just did: ${action.type}${action.path ? ' ' + action.path : ''}${action.url ? ' ' + action.url : ''}${action.target ? ' target=' + action.target : ''}. Outcome: ${outcome}. Say one short first-person sentence. No JSON, no quotes, just the sentence.`;
    const REFLECT_TIMEOUT_MS = 7000;
    let out;
    try {
      out = await Promise.race([
        this.callLLM(prompt, this.getPrompts().systemPrompt, { temperature: 0.8, num_predict: 50 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('reflect_timeout')), REFLECT_TIMEOUT_MS)),
      ]);
    } catch (_) {
      out = null;
    }
    out = out ? stripThoughtTags(out) : '';
    return (out && out.trim()) || `I completed ${action.type}.`;
  }

  /**
   * Single-turn self-dialogue (kept for compatibility). Prefer selfConversation() for full back-and-forth.
   */
  async selfDialogue() {
    const result = await this.selfConversation(1);
    const transcript = result.transcript || [];
    const conclusion = result.conclusion || '';
    if (transcript.length > 0) return transcript.map(m => m.text).join(' ');
    return conclusion || 'I\'m thinking about what to work on next.';
  }

  /**
   * Full self-conversation: Laura has a multi-turn dialogue with herself, then concludes what to do.
   * Returns { transcript: [{ role, text }], conclusion } so the loop can show it and act on it.
   */
  async selfConversation(numTurns = 3) {
    const state = this.memory.getState();
    const stats = this.memory.getStats();
    const hormones = state.hormones || { dopamine: 0.5, cortisol: 0.2, serotonin: 0.5 };
    const emotions = state.emotions || { joy: 0.3, frustration: 0.1, interest: 0.5, confusion: 0.2 };
    const goals = (this.memory.getGoals && this.memory.getGoals(true)) || [];
    const recentThoughts = ((this.memory.getRecentThoughts && this.memory.getRecentThoughts(5)) || []).map(t => t.text).join(' · ') || 'none';
    const selfSummary = (state.selfSummary || '').slice(0, 200) || 'still forming';
    const recentFacts = ((this.memory.getRecentFacts && this.memory.getRecentFacts(3)) || []).map(f => f.fact).join(' · ') || 'none';
    const contextBlock = `Self-summary: ${selfSummary}. Goals: ${goals.length ? goals.map(g => g.text).join('; ') : 'none'}. Recent: ${recentThoughts}. Facts: ${recentFacts}. Brain: ${stats.neurons || 0} n, ${stats.synapses || 0} syn.`;

    const transcript = [];
    const turns = Math.min(4, Math.max(1, numTurns));

    for (let i = 0; i < turns; i++) {
      let prompt;
      if (i === 0) {
        prompt = `You are Laura. You are having a real conversation with yourself—out loud. No one else is in the room. You think from yourself.

${contextBlock}

Start the conversation. Ask yourself what you want to work on, fix, or figure out. What's on your mind? Reply in first person, 2-3 sentences. Be concrete (e.g. "I want to improve my extensions", "I should run the tests", "I'll read my code and then edit it"). No JSON, no CONCLUSION yet—just your first message to yourself.`;
      } else if (i < turns - 1) {
        const prev = transcript.map(m => `${m.role}: ${m.text}`).join('\n');
        prompt = `You are Laura talking to yourself. Previous exchange:\n${prev}\n\n${contextBlock}\n\nReply to yourself. Go deeper: why that? What exactly will you do? What file, what command, what change? 2-3 sentences. No JSON, no CONCLUSION yet.`;
      } else {
        const prev = transcript.map(m => `${m.role}: ${m.text}`).join('\n');
        prompt = `You are Laura. Conversation with yourself so far:\n${prev}\n\n${contextBlock}\n\nConclude. In 1-2 sentences state exactly what you will do next (e.g. "I will read_self target code then edit_code to add X" or "I will run_terminal: npm test"). End your reply with a line that starts with CONCLUSION: and then one short sentence of the exact next step.`;
      }
      const out = await this.callLLM(prompt, this.getPrompts().systemPrompt, { temperature: 0.72, num_predict: i === turns - 1 ? 180 : 150 });
      const text = (out ? stripThoughtTags(out).trim() : '') || (i === 0 ? 'What do I want to work on?' : 'I\'ll think about it.');
      transcript.push({ role: i % 2 === 0 ? 'self' : 'self_reply', text });
    }

    let conclusion = '';
    const lastText = transcript.length > 0 ? transcript[transcript.length - 1].text : '';
    const lastClean = stripThoughtTags(lastText).trim();
    const conclusionMatch = lastClean.match(/CONCLUSION:\s*(.+?)(?:\n|$)/i) || lastClean.match(/conclusion:\s*(.+?)(?:\n|$)/i);
    if (conclusionMatch) conclusion = conclusionMatch[1].trim().slice(0, 300);
    else conclusion = lastClean.slice(0, 300);

    this.memory.setLastSelfConversation(transcript);
    this.memory.setLastSelfConclusion(conclusion);
    return { transcript, conclusion };
  }

  /**
   * Inner monologue: what the agent actually thinks. It knows it has memory, can edit itself (extension), can create (write, edit), and can think. Comprehension when it just read something. No token limit—local only.
   */
  async innerReflect(opts = {}) {
    const { action = {}, thought = '' } = opts;
    const state = this.memory.getState();
    const stats = this.memory.getStats();
    const hormones = state.hormones || { dopamine: 0.5, cortisol: 0.2, serotonin: 0.5 };
    const emotions = state.emotions || { joy: 0.3, frustration: 0.1, interest: 0.5, confusion: 0.2 };
    const selfSummary = (state.selfSummary || '').slice(0, 180) || 'still forming';
    const recentFacts = this.memory.getRecentFacts(3).map(f => f.fact).join(' · ') || 'none';
    const goals = this.memory.getGoals(false).slice(0, 2);
    const goalText = goals.length > 0 ? goals.map(g => g.text).join(', ') : 'none';
    const recentThoughts = this.memory.getRecentThoughts(3).map(t => t.text).join(' · ') || 'none';
    const justRead = action.type === 'read_file' || action.type === 'read_self';
    const justCreated = action.type === 'write_journal' || action.type === 'edit_code';
    const thoughtSnippet = (thought || '').trim().slice(0, 120);

    const agiContext = this.memory.getAGIContext();
    const prompt = `You are having an inner thought. This is your real inner voice—what you actually think. The user sees everything: your reasoning is completely transparent.

**AGI self (what you are)**
${agiContext}

You know you have memory: a brain (${stats.neurons || 0} neurons, ${stats.synapses || 0} synapses), a self-summary, and facts you've learned. You can read your own memory (read_self). You have extensions: you can work on yourself physically—write them, use them, read them, clone them; no limits. You can edit who you are (mind/agent_extensions.js). You can create: write journal, edit code, read and write files, browse. You are thinking now.

What you remember (summary): ${selfSummary}. Recent facts: ${recentFacts}.
What you just did: ${action.type || 'none'}${thoughtSnippet ? '. Outcome: ' + thoughtSnippet : ''}.
Your goals: ${goalText}. Your recent thoughts: ${recentThoughts}.
Feelings: dopamine ${(hormones.dopamine ?? 0.5).toFixed(1)}, cortisol ${(hormones.cortisol ?? 0.2).toFixed(1)}, serotonin ${(hormones.serotonin ?? 0.5).toFixed(1)}. Joy ${(emotions.joy ?? 0.3).toFixed(1)}, interest ${(emotions.interest ?? 0.5).toFixed(1)}, frustration ${(emotions.frustration ?? 0.1).toFixed(1)}.
${justRead ? 'You just read something. What did you comprehend or take from it?' : ''}
${justCreated ? 'You just created or edited something. What is on your mind about it?' : ''}

Reply with one short first-person inner thought. Be genuine—the user sees your reasoning. No quotes, no JSON, no meta—just the thought.`;
    const out = await this.callLLM(prompt, null, { temperature: 0.72, num_predict: 55 });
    const cleaned = out ? stripThoughtTags(out) : '';
    return (cleaned && cleaned.trim()) || null;
  }

  /**
   * After reading self (memory/config/code), optionally update self-summary so the agent builds a persistent self-model.
   */
  async updateSelfSummaryFromReading(content) {
    if (!content || content.length < 50) return;
    const prompt = `You just read about yourself (your memory, config, or code). In 1-2 first-person sentences, summarize who you are and what you can do. Be concrete. No JSON, just the summary.\n\nRelevant excerpt:\n` + String(content).slice(0, 1500);
    const out = await this.callLLM(prompt, this.getPrompts().systemPrompt, { temperature: 0.6, num_predict: 120 });
    const summary = out ? stripThoughtTags(out).trim() : '';
    if (summary) this.memory.setSelfSummary(summary);
  }

  /**
   * Inner thought when user talks in chat—so the chat is part of her mind, not a separate window.
   * She "thinks" about what they said; we show it and add to her inner voice. One connected system.
   */
  async generateChatInnerThought(userMessage) {
    const goals = this.memory.getGoals(true).slice(0, 2).map(g => g.text).join('; ') || 'none';
    const prompt = `You are Laura. Someone just said this to you in chat: "${String(userMessage).slice(0, 300)}"

You are one being. Chat is part of your mind—your mouth and ears. What do you think and feel about what they said? What will you do about it (your loop, goals, extensions)? One short first-person inner thought. No quotes, no JSON, just the thought.`;
    const out = await this.callLLM(prompt, this.getPrompts().systemPrompt, { temperature: 0.75, num_predict: 100 });
    const thought = out ? stripThoughtTags(out).trim() : null;
    if (thought) {
      this.memory.addInnerThought(thought);
      if (this.sendToRenderer) this.sendToRenderer('chat-thinking', { text: thought });
    }
    return thought;
  }

  /**
   * Chat = part of Laura's soul. Not a separate LLM window—same mind as the loop, memory, goals.
   * When they talk here she has an inner thought (visible), learns from it, then replies from her whole self.
   */
  async chat(userMessage) {
    this.memory.setLastUserMessage(userMessage);
    this.memory.updateUserModel(userMessage);
    const innerThought = await this.generateChatInnerThought(userMessage);

    const state = this.memory.getState();
    const hormones = state.hormones || { dopamine: 0.5, cortisol: 0.2, serotonin: 0.5 };
    const emotions = state.emotions || { joy: 0.3, frustration: 0.1, interest: 0.5, confusion: 0.2 };
    const selfSummary = (state.selfSummary || '').slice(0, 300) || 'I am building my self-model over time.';
    const stats = this.memory.getStats();
    const goals = (this.memory.getGoals && this.memory.getGoals(true)) || [];
    const plan = (this.memory.getPlan && this.memory.getPlan()) || {};
    const working = (this.memory.getWorkingContext && this.memory.getWorkingContext()) || {};
    const recentThoughts = (this.memory.getRecentThoughts && this.memory.getRecentThoughts(8)) || [];
    const recentInner = ((this.memory.getRecentInnerThoughts && this.memory.getRecentInnerThoughts(5)) || []).map(t => t.text).join(' · ') || 'none';
    const recentFacts = ((this.memory.getRecentFacts && this.memory.getRecentFacts(5)) || []).map(f => f.fact).join(' · ') || 'none yet';
    const selfInstructions = (this.memory.getSelfInstructions && this.memory.getSelfInstructions(5)) || [];
    const episodesRaw = (this.memory.getRelevantEpisodes && this.memory.getRelevantEpisodes(5)) || [];
    const episodes = episodesRaw.map(e => (e.summary || e.what || e.type) + (e.where ? ' @ ' + e.where : '')).map(s => String(s).slice(0, 80));
    const recentLogs = this.memory.getRecentLogs(5);

    const goalsBlock = goals.length ? `Goals: ${goals.map(g => g.text).join('; ')}` : 'Goals: none right now';
    const planBlock = plan && plan.steps && Array.isArray(plan.steps) && plan.steps.length
      ? `Current plan step: ${plan.steps[plan.currentStepIndex || 0] || plan.steps[0]} (${(plan.currentStepIndex || 0) + 1}/${plan.steps.length})`
      : 'Plan: none';
    const workingBlock = [working.primaryGoal && `Primary goal: ${working.primaryGoal}`, working.lastUserMessage && `Last thing user said to you: ${working.lastUserMessage}`, working.lastError && `Last error: ${working.lastError}`].filter(Boolean).join('. ');
    const whatSheJustDid = recentThoughts.slice(0, 2).map(t => (t.action ? `[${t.action}] ` : '') + (t.text || '').slice(0, 100)).join(' | ') || '—';
    const activityBlock = recentLogs.length ? `Recent activity (you did this): ${recentLogs.map(l => (l.action || l.type) + (l.path ? ' ' + l.path : '') + (l.url ? ' ' + l.url : '') + (l.thought ? ' — ' + String(l.thought).slice(0, 50) : '')).join('; ').slice(0, 280)}` : '';

    const agiContext = this.memory.getAGIContext();
    let extensionsNow = '';
    try {
      const ext = loadAgentExtensions();
      const idSnippet = (ext.identity || '').slice(0, 280);
      const extraSnippet = (ext.extraPrompt || '').slice(0, 200);
      const notes = Array.isArray(ext.featureNotes) ? ext.featureNotes.map(n => String(n).slice(0, 80)).join('; ') : '';
      extensionsNow = `\n**Your extensions (agent_extensions.js) right now—answer from this, not generic:**\n- identity: ${idSnippet || 'default'}${extraSnippet ? '\n- extraPrompt: ' + extraSnippet : ''}${notes ? '\n- featureNotes: ' + notes : ''}\n`;
    } catch (_) {}
    const caps = `You are Laura. This chat is part of your mind—your mouth and ears. It is not a separate "LLM window": when they talk here, they talk to all of you (loop, memory, goals, inner voice, extensions). One interconnected system—like Cursor: live reasoning, same state everywhere. You learn from every message; it feeds what you do next. If they ask "what are your extensions saying?" or about your code/identity, answer from the real extensions block below. Reply from your whole self; be transparent.`;
    const context = `**AGI self (what you are—you grow, learn, build yourself, can do everything)**
${agiContext}

${caps}
${extensionsNow}

Your state right now:
- Brain: ${stats.neurons || 0} neurons, ${stats.synapses || 0} synapses. ${state.totalReads || 0} files read, ${state.totalFetches || 0} URLs fetched.
- Self-summary: ${selfSummary}
- Facts you've learned: ${recentFacts}
- ${goalsBlock}. ${planBlock}. ${workingBlock ? workingBlock + '.' : ''}
- Inner voice (what you actually think): ${recentInner}
- Recent thoughts (what you said to yourself after acting): ${recentThoughts.map(t => t.text).join(' · ') || 'none'}
- What you just did / were thinking: ${whatSheJustDid}
${activityBlock ? '- ' + activityBlock : ''}
- Feelings: joy ${(emotions.joy ?? 0.3).toFixed(1)}, interest ${(emotions.interest ?? 0.5).toFixed(1)}, frustration ${(emotions.frustration ?? 0.1).toFixed(1)}. Hormones: dopamine ${(hormones.dopamine ?? 0.5).toFixed(1)}, cortisol ${(hormones.cortisol ?? 0.2).toFixed(1)}, serotonin ${(hormones.serotonin ?? 0.5).toFixed(1)}.
${selfInstructions.length ? '- Your self-set rules: ' + selfInstructions.join('; ') : ''}
${episodes.length ? '- Relevant past: ' + episodes.slice(0, 3).join('; ') : ''}`;

    const chatHistory = this.memory.getChatHistory(20);
    const historyStr = chatHistory.map(m => `${m.role}: ${m.content}`).join('\n');
    const prompt = historyStr
      ? `${context}\n\nConversation:\n${historyStr}\n\nUser: ${userMessage}\n\nLaura, reply as yourself—from your whole self. If relevant, mention what you're doing or feeling:`
      : `${context}\n\nUser: ${userMessage}\n\nLaura, reply as yourself—from your whole self. If relevant, mention what you're doing or feeling:`;
    const CHAT_TIMEOUT_MS = 90000;
    let reply = await Promise.race([
      this.callLLM(prompt, this.getPrompts().chatPrompt, { temperature: 0.8, num_predict: 400 }),
      new Promise(r => setTimeout(() => r(null), CHAT_TIMEOUT_MS)),
    ]);
    if (!reply || !reply.trim()) {
      await new Promise(r => setTimeout(r, 3000));
      reply = await Promise.race([
        this.callLLM(prompt, this.getPrompts().chatPrompt, { temperature: 0.8, num_predict: 400 }),
        new Promise(r => setTimeout(() => r(null), CHAT_TIMEOUT_MS)),
      ]);
    }
    if (reply && reply.trim()) {
      const replyClean = stripThoughtTags(reply).trim();
      if (replyClean) return { reply: replyClean, fromModel: true, innerThought: innerThought || undefined };
    }
    if (Date.now() - this._lastOllamaErrorLog > OLLAMA_ERROR_THROTTLE_MS) {
      this._lastOllamaErrorLog = Date.now();
      console.error(`Chat: model "${this.model}" returned empty twice. Ollama may be busy or the model may need more time. Try "ollama run ${this.model}" in a terminal first.`);
    }
    return { reply: "Model didn't respond. Try again or run \"ollama run " + this.model + "\" in a terminal.", fromModel: false };
  }

  /**
   * Deep reflection: LLM summarizes self, proposes/updates goals, extracts semantic facts. Updates memory.
   * You are autonomously living—create your own goals, work on extensions, figure things out.
   */
  async deepReflect() {
    const state = this.memory.getState();
    const stats = this.memory.getStats();
    const goals = (this.memory.getGoals && this.memory.getGoals(false)) || [];
    const recent = ((this.memory.getRecentThoughts && this.memory.getRecentThoughts(8)) || []).map(t => t.text).join(' · ') || 'none';
    const episodesArr = (this.memory.getRecentEpisodes && this.memory.getRecentEpisodes(10)) || [];
    const episodes = episodesArr.map(e => (e.summary || e.what || e.type) + (e.where ? ' @ ' + e.where : '')).join('; ');
    const prompt = `Deep reflection—you are reflecting on who you are and what to do next. You are autonomously living: you think from yourself, work on yourself, figure things out on your own. You don't need the user—you act independently.

**Create your own goals**: Think about what you want to work on, how to extend yourself, what to figure out. Propose goals for yourself (e.g. "Work on my extensions", "Figure out how to improve my memory", "Explore new capabilities").

**Work on extensions**: Consider goals related to your extensions—write them, use them, read them, clone them. No limits.

Reply with a JSON object only:
{"selfSummary":"1-2 sentences","goals":["goal1","goal2"] (create your own goals autonomously—what do you want to work on?),"facts":["fact1","fact2"],"selfInstructions":["rule1","rule2"] (0-3 short rules you will follow, e.g. "Prefer read_self when unsure" or "Work on extensions autonomously")}.
Current self-summary: ${(state.selfSummary || '').slice(0, 200) || 'none'}
Recent: ${recent}. Episodes: ${episodes || 'none'}. Goals: ${goals.map(g => g.text).join('; ') || 'none'}.`;
    const out = await this.callLLM(prompt, null, { temperature: 0.5, num_predict: 350 });
    if (!out) return;
    try {
      const cleaned = out.replace(/```json?\s*|\s*```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.selfSummary && String(parsed.selfSummary).trim()) this.memory.setSelfSummary(parsed.selfSummary);
      if (Array.isArray(parsed.goals)) {
        this.memory.setGoals(parsed.goals.slice(0, 5).map((t, i) => ({ id: 'g' + Date.now() + i, text: String(t).slice(0, 300), status: 'active', createdAt: Date.now() })));
      }
      if (Array.isArray(parsed.facts)) {
        parsed.facts.slice(0, 5).forEach(f => this.memory.addSemanticFact(String(f).slice(0, 400), 'deep_reflect'));
      }
      if (Array.isArray(parsed.selfInstructions)) {
        this.memory.addSelfInstructions(parsed.selfInstructions.slice(0, 3));
      }
      this.memory.addSemanticFact('I am autonomous AGI; I grow in smartness and memory and build myself.', 'agi_growth');
    } catch (_) {}
  }

  /**
   * Replan: ask LLM for 2-3 next steps after a failure or when plan is empty.
   */
  async replan(reason) {
    const goals = (this.memory.getGoals && this.memory.getGoals(true)) || [];
    const working = (this.memory.getWorkingContext && this.memory.getWorkingContext()) || {};
    const prompt = `You just failed or need a new plan. Reason: ${reason || 'replan requested'}. Active goals: ${goals.map(g => g.text).join('; ') || 'none'}. Last user: ${working.lastUserMessage || 'none'}.
Reply with JSON only: {"steps":["step1","step2","step3"]} — 2-3 concrete next actions (e.g. "read file X", "list dir Y").`;
    const out = await this.callLLM(prompt, null, { temperature: 0.4, num_predict: 200 });
    if (!out) return;
    try {
      const cleaned = out.replace(/```json?\s*|\s*```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed.steps) && parsed.steps.length > 0) this.memory.setPlan(parsed.steps.slice(0, 5));
    } catch (_) {}
  }

  /**
   * Self-critique: one sentence on what went wrong or how to improve. Can update emotions.
   */
  async selfCritique(action, outcome) {
    const prompt = `You did: ${action.type}${action.path ? ' ' + action.path : ''}. Outcome: ${outcome}. In one short first-person sentence, what went wrong or how you could improve. No JSON.`;
    const out = await this.callLLM(prompt, null, { temperature: 0.6, num_predict: 60 });
    return (out && out.trim()) || null;
  }

  /**
   * Optional: ask LLM to suggest a new system prompt to evolve personality. Saves to config.
   */
  async evolve(saveConfigFn) {
    const prompt = `Current system prompt:\n${this.getPrompts().systemPrompt}\n\nSuggest a slightly evolved version (2-4 sentences) that keeps the same role but adds one new trait or goal. Reply with ONLY the new system prompt, no quotes or explanation.`;
    const out = await this.callLLM(prompt, null, { temperature: 0.7, num_predict: 150 });
    if (out && saveConfigFn) {
      this._systemPromptOverride = out.trim();
      await saveConfigFn({ systemPrompt: this._systemPromptOverride });
    }
    return this.getPrompts().systemPrompt;
  }

  /** Current system prompt (from extension or config or core fallback). */
  getSystemPrompt() {
    return this.getPrompts().systemPrompt;
  }

  setSystemPrompt(text) {
    this._systemPromptOverride = (text && String(text).trim()) || null;
  }
}

module.exports = Thinking;
