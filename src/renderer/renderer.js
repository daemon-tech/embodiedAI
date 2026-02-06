(function() {
  if (!window.api) return;

  const unsubscribes = [];
  const thoughtsList = document.getElementById('thoughts-list');
  const logsList = document.getElementById('logs-list');
  const currentThought = document.getElementById('current-thought');
  function setupTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const name = tab.dataset.tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const content = document.getElementById('tab-' + name);
        if (content) content.classList.add('active');
      });
    });
  }
  setupTabs();
  const actionTag = document.getElementById('action-tag');
  const statLine = document.getElementById('stat-line');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const btnVoice = document.getElementById('btn-voice');

  let speechSynth = window.speechSynthesis;
  let voiceEnabled = true;

  function formatTime(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatRelativeTime(ms) {
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60) return 'just now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    return formatTime(ms);
  }

  function renderThought(t, isNew) {
    const el = document.createElement('div');
    el.className = 'thought-item' + (isNew ? ' item-new' : '');
    const timeTitle = formatTime(t.t);
    const action = (t.action && String(t.action)) || '';
    const actionHtml = action ? '<span class="thought-action">' + escapeHtml(action) + '</span>' : '';
    el.innerHTML =
      '<div class="thought-meta">' +
      '<span class="thought-time" title="' + escapeHtml(timeTitle) + '">' + formatRelativeTime(t.t) + '</span>' +
      actionHtml +
      '</div>' +
      '<div class="thought-text">' + escapeHtml(t.text || '') + '</div>';
    return el;
  }

  function renderLog(l) {
    const el = document.createElement('div');
    el.className = 'log-item';
    const type = l.type || 'log';
    const payload = [l.path, l.url, l.target, l.command].filter(Boolean).join(' ') || '';
    el.innerHTML =
      '<span class="log-time" title="' + escapeHtml(formatTime(l.t)) + '">' + formatRelativeTime(l.t) + '</span>' +
      '<span class="log-type">' + escapeHtml(type) + '</span>' +
      (payload ? '<span class="log-payload" title="' + escapeHtml(payload) + '">' + escapeHtml(payload.slice(0, 120)) + (payload.length > 120 ? '…' : '') + '</span>' : '');
    return el;
  }

  function escapeHtml(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  let focusMode = false;

  async function refreshStats() {
    try {
      const s = await window.api.getMemoryStats();
      const p = s.exploredPaths || 0, u = s.exploredUrls || 0, t = s.thoughts || 0, n = s.neurons || 0, syn = s.synapses || 0;
      if (statLine) {
        statLine.innerHTML = '<span class="hi">' + p + '</span> paths · <span class="hi">' + t + '</span> th · <span class="hi">' + n + '</span> n' + (focusMode ? ' · focus' : '');
      }
      updateNeuralGraph(s);
      refreshResourceLine(s);
    } catch (_) {}
  }

  async function refreshResourceLine(memoryStats) {
    const appEl = document.getElementById('v-app-mb');
    const sysEl = document.getElementById('v-sys-mem');
    if (!appEl && !sysEl) return;
    try {
      const ru = await window.api.getResourceUsage();
      const appMB = Math.round((ru.appRss || 0) / 1024 / 1024);
      const sysFreeGB = (ru.systemFreeMem || 0) / 1024 / 1024 / 1024;
      const sysTotalGB = (ru.systemTotalMem || 0) / 1024 / 1024 / 1024;
      if (appEl) appEl.textContent = appMB + ' MB';
      if (sysEl) sysEl.textContent = sysFreeGB.toFixed(1) + ' / ' + sysTotalGB.toFixed(1) + ' GB';
    } catch (_) {
      if (appEl) appEl.textContent = '—';
      if (sysEl) sysEl.textContent = '—';
    }
  }


  function updateNeuralGraph(stats) {
    if (!stats) return;
    // Neural graph is now 3D: nodes and lines hover with the AI orb in scene.js
    if (window.scene3d && window.scene3d.setNeuralStats) window.scene3d.setNeuralStats(stats);
  }

  async function refreshGoals() {
    const list = document.getElementById('goals-list');
    const countEl = document.getElementById('goals-count');
    if (!list) return;
    try {
      const goals = await window.api.getGoals();
      const all = goals || [];
      const active = all.filter(g => g.status === 'active');
      if (countEl) countEl.textContent = active.length + ' active' + (all.length > active.length ? ', ' + (all.length - active.length) + ' done' : '');
      list.innerHTML = '';
      all.forEach(g => {
        const el = document.createElement('div');
        el.className = 'goal-item' + (g.status === 'done' ? ' goal-done' : '');
        el.dataset.id = g.id;
        const textSpan = document.createElement('span');
        textSpan.className = 'goal-text';
        textSpan.textContent = g.text;
        el.appendChild(textSpan);
        if (g.status === 'active') {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'goal-done';
          btn.textContent = 'Done';
          btn.addEventListener('click', () => { window.api.completeGoal(g.id); refreshGoals(); });
          el.appendChild(btn);
        }
        list.appendChild(el);
      });
    } catch (_) {}
  }

  async function refreshInnerThoughts() {
    const list = document.getElementById('inner-thoughts-list');
    const emptyEl = document.getElementById('inner-empty');
    if (!list) return;
    try {
      const arr = (await window.api.getInnerThoughts()) || [];
      list.innerHTML = '';
      if (emptyEl) emptyEl.style.display = arr.length === 0 ? 'block' : 'none';
      arr.slice(0, 16).forEach((t, i) => {
        const el = document.createElement('div');
        el.className = 'inner-item' + (i === 0 ? ' inner-item-new' : '');
        el.innerHTML = '<span class="inner-time" title="' + escapeHtml(formatTime(t.t)) + '">' + formatRelativeTime(t.t) + '</span><div class="inner-text">' + escapeHtml(t.text || '') + '</div>';
        list.appendChild(el);
      });
    } catch (_) {}
  }

  async function refreshThoughts() {
    if (!thoughtsList) return;
    const emptyEl = document.getElementById('thoughts-empty');
    try {
      const list = await window.api.getThoughts(50);
      thoughtsList.innerHTML = '';
      if (list.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
      } else {
        if (emptyEl) emptyEl.style.display = 'none';
        list.forEach((t, i) => thoughtsList.appendChild(renderThought(t, i === 0)));
      }
    } catch (_) {
      if (emptyEl) emptyEl.style.display = 'block';
    }
  }

  async function refreshLogs() {
    const emptyEl = document.getElementById('logs-empty');
    if (!logsList) return;
    try {
      const list = await window.api.getLogs(80);
      logsList.innerHTML = '';
      if (emptyEl) emptyEl.style.display = list.length === 0 ? 'block' : 'none';
      list.forEach(l => logsList.appendChild(renderLog(l)));
    } catch (_) {}
  }

  function appendStreamToChat(type, label, body, thoughtMs) {
    if (!chatMessages || !body) return;
    const div = document.createElement('div');
    div.className = 'chat-msg stream ' + type;
    const timeHtml = (thoughtMs != null && thoughtMs >= 0)
      ? '<span class="stream-time">Thought ' + (thoughtMs < 1000 ? thoughtMs + 'ms' : (thoughtMs / 1000).toFixed(1) + 's') + '</span>'
      : '';
    div.innerHTML =
      '<div class="stream-head"><span class="stream-label">' + escapeHtml(label) + '</span>' + timeHtml + '</div>' +
      '<div class="stream-body">' + escapeHtml(body) + '</div>';
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function renderMessageContent(text) {
    if (!text) return '';
    const blocks = [];
    const inlines = [];
    let rest = text.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push(escapeHtml(code.trim()));
      return '{{BLOCK_' + (blocks.length - 1) + '}}';
    });
    rest = rest.replace(/`([^`\n]+)`/g, function (_, code) {
      inlines.push(escapeHtml(code));
      return '{{INLINE_' + (inlines.length - 1) + '}}';
    });
    rest = escapeHtml(rest);
    for (let i = blocks.length - 1; i >= 0; i--) {
      rest = rest.split('{{BLOCK_' + i + '}}').join('<pre><code>' + blocks[i] + '</code></pre>');
    }
    for (let i = inlines.length - 1; i >= 0; i--) {
      rest = rest.split('{{INLINE_' + i + '}}').join('<code>' + inlines[i] + '</code>');
    }
    return rest.replace(/\n/g, '<br>');
  }

  function setCurrentThought(msg) {
    const text = (msg && msg.thought != null) ? String(msg.thought).trim() : (typeof msg === 'string' ? msg : '');
    const reason = (msg && msg.reason != null) ? String(msg.reason).trim() : '';
    const action = (msg && msg.action != null) ? msg.action : (typeof msg === 'object' ? '' : '');
    if (currentThought) {
      currentThought.textContent = text || 'Idle';
      currentThought.classList.toggle('is-idle', !text);
    }
    const reasonEl = document.getElementById('current-reason');
    if (reasonEl) {
      reasonEl.textContent = reason ? 'Live reasoning: ' + reason : '';
      reasonEl.style.display = reason ? 'block' : 'none';
    }
    if (actionTag) {
      actionTag.textContent = action || '';
      actionTag.style.display = action ? 'inline-block' : 'none';
    }
    const liveReason = document.getElementById('chat-live-reason');
    const liveAction = document.getElementById('chat-live-action');
    const liveThought = document.getElementById('chat-live-thought');
    const liveBlock = document.getElementById('chat-live-block');
    if (liveReason) liveReason.textContent = reason ? 'Reasoning: ' + reason : '';
    if (liveAction) {
      const payload = (msg && msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
      const detail = String(payload.path || payload.url || payload.target || payload.command || '').slice(0, 200);
      liveAction.textContent = action ? 'Action: ' + action + (detail ? ' ' + detail : '') : '';
    }
    if (liveThought) liveThought.textContent = text || '—';
    if (liveBlock) {
      liveBlock.classList.add('updated');
      clearTimeout(window._chatLiveFlash);
      window._chatLiveFlash = setTimeout(function () { liveBlock.classList.remove('updated'); }, 400);
    }
    if (msg && msg.metrics) updateMetricsDisplay(msg.metrics);
  }

  function formatActivity(activity) {
    if (!activity || !activity.phase) return '—';
    const p = activity.phase;
    const d = activity.detail;
    if (p === 'tick') return 'Starting tick';
    if (p === 'decide') return 'Deciding action';
    if (p === 'execute') return d ? 'Executing ' + d : 'Executing';
    if (p === 'reflect') return 'Reflecting';
    if (p === 'idle') return 'Idle (next in ' + (activity.detail || '?') + ' ms)';
    if (p === 'error') return 'Error: ' + (d || '—');
    return p;
  }

  function updateMetricsDisplay(m) {
    const v = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val != null && val !== '' ? val : '—';
    };
    v('v-activity', m.activity ? formatActivity(m.activity) : null);
    v('v-actions-per-min', m.speed && m.speed.actionsPerMinute != null ? m.speed.actionsPerMinute.toFixed(1) : null);
    v('v-thoughts-per-min', m.speed && m.speed.thoughtsPerMinute != null ? m.speed.thoughtsPerMinute.toFixed(1) : null);
    v('v-avg-decide-ms', m.latency && m.latency.avgDecideMs != null ? m.latency.avgDecideMs : null);
    v('v-avg-action-ms', m.latency && m.latency.avgActionMs != null ? m.latency.avgActionMs : null);
    v('v-last-decide-ms', m.latency && m.latency.lastDecideMs != null ? m.latency.lastDecideMs : null);
    v('v-last-action-ms', m.latency && m.latency.lastActionMs != null ? m.latency.lastActionMs : null);
    v('v-last-tick-ms', m.latency && m.latency.lastTickMs != null ? m.latency.lastTickMs : null);
  }

  let lastLivingState = { hormones: {}, emotions: {}, stats: {}, living: {} };

  function updateMindCore(state) {
    if (!state) state = lastLivingState;
    const h = state.hormones || {};
    const e = state.emotions || {};
    const s = state.stats || {};
    const pct = (v) => Math.round(Math.min(1, Math.max(0, (v ?? 0.5))) * 100) + '%';
    const setBar = (id, v) => { const el = document.getElementById(id); if (el) el.style.width = pct(v); };
    setBar('core-dopamine', h.dopamine);
    setBar('core-cortisol', h.cortisol);
    setBar('core-serotonin', h.serotonin);
    const setStat = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = (v ?? 0); };
    setStat('core-neurons', s.neurons);
    setStat('core-synapses', s.synapses);
    setStat('core-thoughts', s.thoughts);
  }

  function updateVitalsDrawer(state) {
    if (!state) state = lastLivingState;
    const s = state.stats || {};
    const liv = state.living || {};
    updateMindCore(state);
    const nEl = document.getElementById('v-neurons');
    const synEl = document.getElementById('v-synapses');
    const thEl = document.getElementById('v-thoughts');
    const epEl = document.getElementById('v-episodes');
    if (nEl) nEl.textContent = s.neurons ?? 0;
    if (synEl) synEl.textContent = s.synapses ?? 0;
    if (thEl) thEl.textContent = s.thoughts ?? 0;
    if (epEl) epEl.textContent = s.episodes ?? 0;
    const intervalEl = document.getElementById('v-interval');
    if (intervalEl) intervalEl.textContent = (liv.nextIntervalMs != null) ? (liv.nextIntervalMs / 1000).toFixed(1) + ' s' : '—';
    updateNextTickCountdown(liv.lastTickTime, liv.nextIntervalMs);
  }

  function updateNextTickCountdown(lastTickTime, nextIntervalMs) {
    const el = document.getElementById('v-next-tick');
    if (!el) return;
    if (lastTickTime == null || nextIntervalMs == null) { el.textContent = '—'; return; }
    const nextAt = lastTickTime + nextIntervalMs;
    const remain = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
    el.textContent = remain + ' s';
  }

  const stepsHistory = [];
  const MAX_STEPS = 30;
  function appendStep(msg) {
    const stepsList = document.getElementById('steps-list');
    const stepsEmpty = document.getElementById('steps-empty');
    if (!stepsList) return;
    const payload = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
    const detail = String(payload.path || payload.url || payload.target || payload.command || '').slice(0, 120);
    stepsHistory.push({ t: Date.now(), action: msg.action, payload, reason: msg.reason, thought: msg.thought });
    if (stepsHistory.length > MAX_STEPS) stepsHistory.shift();
    const el = document.createElement('div');
    el.className = 'step-item';
    el.innerHTML =
      '<div class="step-meta">' +
      '<span class="step-time" title="' + escapeHtml(formatTime(Date.now())) + '">just now</span>' +
      (msg.action ? '<span class="step-action">' + escapeHtml(msg.action) + '</span>' : '') +
      '</div>' +
      (detail ? '<div class="step-detail">' + escapeHtml(detail) + '</div>' : '') +
      (msg.reason ? '<div class="step-detail">Reason: ' + escapeHtml(String(msg.reason).slice(0, 150)) + '</div>' : '') +
      (msg.thought ? '<div class="step-thought">' + escapeHtml(String(msg.thought).slice(0, 200)) + (String(msg.thought).length > 200 ? '…' : '') + '</div>' : '');
    stepsList.insertBefore(el, stepsList.firstChild);
    while (stepsList.children.length > MAX_STEPS) stepsList.removeChild(stepsList.lastChild);
    if (stepsEmpty) stepsEmpty.style.display = 'none';
  }

  const terminalHistory = [];
  const MAX_TERMINAL_HISTORY = 50;
  function appendTerminalEntry(data) {
    terminalHistory.push({ command: data.command, cwd: data.cwd, stdout: data.stdout, stderr: data.stderr, ok: data.ok, ts: data.ts != null ? data.ts : Date.now() });
    if (terminalHistory.length > MAX_TERMINAL_HISTORY) terminalHistory.shift();
    const logEl = document.getElementById('terminal-log');
    const emptyEl = document.getElementById('terminal-empty');
    if (!logEl) return;
    const ts = data.ts != null ? data.ts : Date.now();
    const timeStr = formatTime(ts);
    const cmd = (data.command != null ? String(data.command) : '').trim();
    const stdout = (data.stdout != null ? String(data.stdout) : '').trim();
    const stderr = (data.stderr != null ? String(data.stderr) : '').trim();
    const ok = data.ok === true;
    const div = document.createElement('div');
    div.className = 'terminal-entry' + (ok ? '' : ' terminal-error');
    div.innerHTML =
      '<div class="term-time">' + escapeHtml(timeStr) + (data.cwd ? ' · ' + escapeHtml(String(data.cwd).slice(-50)) : '') + '</div>' +
      '<div class="term-cmd">$ ' + escapeHtml(cmd) + '</div>' +
      (stdout ? '<pre class="term-out">' + escapeHtml(stdout) + '</pre>' : '') +
      (stderr ? '<pre class="term-err">' + escapeHtml(stderr) + '</pre>' : '');
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    if (emptyEl) emptyEl.style.display = 'none';
  }

  unsubscribes.push(window.api.onThought((msg) => {
    setCurrentThought(msg);
    appendStep(msg);
    lastLivingState = {
      hormones: msg.hormones || lastLivingState.hormones,
      emotions: msg.emotions || lastLivingState.emotions,
      stats: msg.stats || lastLivingState.stats,
      living: msg.living || lastLivingState.living,
    };
    updateVitalsDrawer(lastLivingState);
    if (msg.action && window.scene3d && window.scene3d.setMode) window.scene3d.setMode(msg.action);
    if (msg.stats) updateNeuralGraph(msg.stats);
    if (msg.goals && msg.goals.length >= 0) refreshGoals();
    refreshThoughts();
    refreshInnerThoughts();
    refreshStats();
  }));

  if (window.api.onTerminalOutput) {
    unsubscribes.push(window.api.onTerminalOutput(appendTerminalEntry));
  }

  if (window.api.onInnerThought) {
    unsubscribes.push(window.api.onInnerThought((msg) => {
      const list = document.getElementById('inner-thoughts-list');
      const emptyEl = document.getElementById('inner-empty');
      if (list && msg && msg.text) {
        if (emptyEl) emptyEl.style.display = 'none';
        const el = document.createElement('div');
        el.className = 'inner-item inner-item-new';
        el.textContent = msg.text;
        list.insertBefore(el, list.firstChild);
        while (list.children.length > 12) list.removeChild(list.lastChild);
      }
    }));
  }

  if (window.api.onSelfConversation) {
    unsubscribes.push(window.api.onSelfConversation((msg) => {
      const conclusionEl = document.getElementById('self-conversation-conclusion');
      const listEl = document.getElementById('self-conversation-list');
      const emptyEl = document.getElementById('self-talk-empty');
      if (!listEl) return;
      const transcript = msg.transcript || [];
      const conclusion = msg.conclusion || '';
      if (emptyEl) emptyEl.style.display = (transcript.length > 0 || conclusion) ? 'none' : 'block';
      if (conclusionEl) {
        conclusionEl.innerHTML = conclusion ? '<span class="label">Conclusion (she will act on this)</span>' + escapeHtml(conclusion) : '';
      }
      listEl.innerHTML = '';
      transcript.forEach((m) => {
        const div = document.createElement('div');
        div.className = 'self-msg ' + (m.role || 'self');
        div.innerHTML = '<div class="role">' + escapeHtml(m.role === 'self_reply' ? 'Laura (reply to herself)' : 'Laura') + '</div>' + escapeHtml(m.text || '');
        listEl.appendChild(div);
      });
    }));
  }

  unsubscribes.push(window.api.onLog(() => {
    refreshLogs();
    refreshStats();
  }));

  if (window.api.onActivity) {
    unsubscribes.push(window.api.onActivity((activity) => {
      const vActivity = document.getElementById('v-activity');
      if (vActivity) vActivity.textContent = formatActivity(activity);
    }));
  }
  if (window.api.onMetrics) {
    unsubscribes.push(window.api.onMetrics((m) => {
      updateMetricsDisplay(m);
    }));
  }
  (async function initMetrics() {
    try {
      const m = await window.api.getMetrics();
      if (m) updateMetricsDisplay(m);
      const a = await window.api.getCurrentActivity();
      if (a) {
        const activityEl = document.getElementById('activity-now');
        if (activityEl) activityEl.textContent = formatActivity(a);
      }
    } catch (_) {}
  })();
  unsubscribes.push(window.api.onLoopStatus((msg) => {
    if (!statusDot || !statusText) return;
    statusDot.className = 'pulse ';
    const nowBlock = document.getElementById('now-block');
    const livingBadge = document.getElementById('living-badge');
    if (msg.paused) {
      statusDot.classList.add('pause');
      statusText.textContent = 'Paused';
      if (nowBlock) nowBlock.classList.remove('live');
      if (livingBadge) { livingBadge.textContent = 'PAUSED'; livingBadge.className = 'living-badge paused'; livingBadge.title = 'Loop paused — not ticking'; }
    } else if (msg.running) {
      statusDot.classList.add('run');
      statusText.textContent = 'Autonomous';
      if (nowBlock) nowBlock.classList.add('live');
      if (livingBadge) { livingBadge.textContent = 'LIVING'; livingBadge.className = 'living-badge'; livingBadge.title = 'She is living — loop running'; }
    } else {
      statusDot.classList.add('stop');
      statusText.textContent = 'Stopped';
      if (nowBlock) nowBlock.classList.remove('live');
      if (livingBadge) { livingBadge.textContent = 'STOP'; livingBadge.className = 'living-badge stop'; livingBadge.title = 'Loop stopped'; }
    }
  }));

  window.api.onSpeakRequest && unsubscribes.push(window.api.onSpeakRequest((text) => {
    if (!voiceEnabled || !speechSynth || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.pitch = 1;
    speechSynth.cancel();
    speechSynth.speak(u);
  }));

  if (window.api.onError) unsubscribes.push(window.api.onError(showToast));
  if (window.api.onToast) unsubscribes.push(window.api.onToast((payload) => showToast(payload && payload.message ? payload.message : String(payload || ''))));

  (async function initSimulationBadge() {
    try {
      const cfg = await window.api.getConfig();
      const badge = document.getElementById('simulation-badge');
      if (badge) badge.style.display = (cfg && cfg.dryRun) ? 'inline-block' : 'none';
    } catch (_) {}
  })();

  const ollamaBanner = document.getElementById('ollama-banner');
  const ollamaBannerText = document.getElementById('ollama-banner-text');
  if (window.api.onOllamaUnavailable) {
    unsubscribes.push(window.api.onOllamaUnavailable((msg) => {
      if (ollamaBanner) {
        if (ollamaBannerText && msg && msg.message) ollamaBannerText.textContent = msg.message;
        ollamaBanner.classList.add('visible');
      }
    }));
  }
  document.getElementById('ollama-banner-dismiss') && document.getElementById('ollama-banner-dismiss').addEventListener('click', () => {
    if (ollamaBanner) ollamaBanner.classList.remove('visible');
  });

  function updateVoiceButton() {
    if (!btnVoice) return;
    btnVoice.textContent = voiceEnabled ? 'Voice On' : 'Voice Off';
    btnVoice.classList.toggle('active', voiceEnabled);
    btnVoice.title = voiceEnabled ? 'Disable speech (TTS)' : 'Enable speech (TTS)';
  }

  async function setVoiceEnabled(enabled) {
    voiceEnabled = !!enabled;
    updateVoiceButton();
    try {
      await window.api.saveConfig({ speakThoughts: voiceEnabled });
    } catch (_) {}
  }

  const btnThinkOnce = document.getElementById('btn-think-once');
  if (btnThinkOnce) {
    btnThinkOnce.addEventListener('click', async () => {
      try {
        btnThinkOnce.disabled = true;
        await window.api.thinkOnce();
      } catch (e) {
        showToast('Think once failed: ' + (e.message || 'error'));
      } finally {
        btnThinkOnce.disabled = false;
      }
    });
  }

  document.getElementById('btn-pause') && document.getElementById('btn-pause').addEventListener('click', async () => {
    try {
      const status = (statusText && statusText.textContent) || '';
      if (status === 'Paused') await window.api.resumeLoop();
      else await window.api.pauseLoop();
    } catch (_) {}
  });

  if (btnVoice) btnVoice.addEventListener('click', () => setVoiceEnabled(!voiceEnabled));

  const btnFocus = document.getElementById('btn-focus');
  function updateFocusButton() {
    if (!btnFocus) return;
    btnFocus.classList.toggle('active', focusMode);
    btnFocus.textContent = focusMode ? 'Focus on' : 'Focus';
    btnFocus.title = focusMode ? 'Disable focus mode' : 'Focus mode: learn faster, read self more';
  }
  if (btnFocus) {
    btnFocus.addEventListener('click', async () => {
      focusMode = !focusMode;
      updateFocusButton();
      try { await window.api.saveConfig({ focusMode }); } catch (_) {}
      refreshStats();
    });
  }

  let continuousMode = false;
  const btnContinuous = document.getElementById('btn-continuous');
  function updateContinuousButton() {
    if (!btnContinuous) return;
    btnContinuous.classList.toggle('active', continuousMode);
    btnContinuous.textContent = continuousMode ? 'Cont. on' : 'Cont.';
    btnContinuous.title = continuousMode ? 'Disable: use normal intervals' : 'Min 800ms between ticks';
  }
  if (btnContinuous) {
    btnContinuous.addEventListener('click', async () => {
      continuousMode = !continuousMode;
      updateContinuousButton();
      try { await window.api.saveConfig({ continuousMode }); } catch (_) {}
    });
  }

  let toastTimer = null;
  function showToast(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove('visible'); toastTimer = null; }, 5000);
  }

  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');

  const CHAT_WIDTH_KEY = 'laura_chatPanelWidth';
  const MIN_CHAT_PX = 280;
  function getMaxChatPx() { return Math.min(900, Math.floor((window.innerWidth || 1200) * 0.85)); }
  function setupChatResizer() {
    const resizer = document.getElementById('chat-resizer');
    const chatPanel = document.querySelector('.chat-panel');
    if (!resizer || !chatPanel) return;
    const root = document.documentElement;
    const saved = parseInt(localStorage.getItem(CHAT_WIDTH_KEY), 10);
    if (!isNaN(saved) && saved >= MIN_CHAT_PX && saved <= getMaxChatPx()) root.style.setProperty('--chat-width', saved + 'px');
    let startX = 0, startWidth = 0;
    function onMove(e) {
      const delta = e.clientX - startX;
      let w = Math.round(startWidth - delta);
      w = Math.max(MIN_CHAT_PX, Math.min(getMaxChatPx(), w));
      root.style.setProperty('--chat-width', w + 'px');
    }
    function onUp() {
      const w = parseInt(getComputedStyle(chatPanel).width, 10);
      if (!isNaN(w)) localStorage.setItem(CHAT_WIDTH_KEY, String(w));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = parseInt(getComputedStyle(chatPanel).width, 10) || 420;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  function appendChatMessage(role, content, isThinking) {
    if (!chatMessages) return;
    const div = document.createElement('div');
    div.className = 'chat-msg ' + (isThinking ? 'thinking' : role);
    if (isThinking) {
      div.textContent = content;
      div.id = 'chat-thinking-current';
    } else if (role === 'assistant') {
      div.innerHTML = '<span class="msg-content">' + renderMessageContent(content) + '</span>';
    } else {
      div.textContent = content;
    }
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
  }

  async function loadChatHistory() {
    if (!chatMessages) return;
    try {
      const history = await window.api.getChatHistory();
      chatMessages.innerHTML = '';
      history.forEach(m => appendChatMessage(m.role, m.content, false));
    } catch (_) {}
  }

  if (chatSend && chatInput) {
    chatSend.addEventListener('click', sendChat);
    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  }
  const feedbackUp = document.getElementById('feedback-up');
  const feedbackDown = document.getElementById('feedback-down');
  if (feedbackUp && window.api.humanFeedback) {
    feedbackUp.addEventListener('click', () => { window.api.humanFeedback('up', ''); showToast('Feedback: positive'); });
  }
  if (feedbackDown && window.api.humanFeedback) {
    feedbackDown.addEventListener('click', () => { window.api.humanFeedback('down', ''); showToast('Feedback: negative — she will adjust'); });
  }

  const copyForCursorBtn = document.getElementById('copy-for-cursor');
  if (copyForCursorBtn && window.api.getDebugInfo) {
    copyForCursorBtn.addEventListener('click', async () => {
      try {
        const info = await window.api.getDebugInfo();
        if (info && info.error) {
          showToast('Failed: ' + info.error);
          return;
        }
        const lines = [];
        lines.push('# Laura debug info — paste this in Cursor so the AI can fix or debug');
        lines.push('Exported: ' + new Date().toISOString());
        lines.push('');
        if (info && info.lastError) {
          lines.push('## Last error');
          lines.push(info.lastError);
          lines.push('');
        }
        if (info && info.actionTrace && info.actionTrace.length > 0) {
          lines.push('## Full trace (everything Laura did — backtrace)');
          info.actionTrace.forEach((e, i) => {
            const ts = e.t != null ? new Date(e.t).toISOString() : '';
            lines.push('---');
            lines.push('[' + (i + 1) + '] ' + ts + '  ' + (e.type || '') + (e.path ? ' path=' + e.path : '') + (e.command ? ' command=' + String(e.command).slice(0, 120) : '') + (e.url ? ' url=' + e.url : '') + (e.target ? ' target=' + e.target : ''));
            if (e.reason) lines.push('  reason: ' + e.reason);
            lines.push('  outcome: ' + (e.ok ? 'ok' : 'error') + (e.error ? ' — ' + e.error : ''));
            if (e.stdout) lines.push('  stdout: ' + e.stdout.replace(/\n/g, ' ').slice(0, 200));
            if (e.thought) lines.push('  thought: ' + e.thought);
          });
          lines.push('');
        }
        if (info && info.activity) {
          lines.push('## Current activity');
          lines.push(typeof info.activity === 'string' ? info.activity : JSON.stringify(info.activity));
          lines.push('');
        }
        if (info && info.living) {
          lines.push('## Loop');
          lines.push('paused: ' + !!info.living.paused + ', nextIntervalMs: ' + (info.living.nextIntervalMs || '—'));
          lines.push('');
        }
        if (info && info.memoryStats) {
          lines.push('## Memory stats');
          lines.push('neurons: ' + (info.memoryStats.neurons || 0) + ', synapses: ' + (info.memoryStats.synapses || 0) + ', thoughts: ' + (info.memoryStats.thoughts || 0) + ', episodes: ' + (info.memoryStats.episodes || 0));
          lines.push('');
        }
        if (info && info.goals && info.goals.length > 0) {
          lines.push('## Active goals');
          info.goals.forEach(g => lines.push('- ' + (g.text || g)));
          lines.push('');
        }
        if (info && info.thoughts && info.thoughts.length > 0) {
          lines.push('## Recent thoughts');
          info.thoughts.slice(0, 25).forEach(t => {
            const a = (t.action || t.type) || '';
            const text = (t.text || '').slice(0, 300);
            lines.push('[' + a + '] ' + text);
          });
          lines.push('');
        }
        if (stepsHistory && stepsHistory.length > 0) {
          lines.push('## Live steps (last ' + stepsHistory.length + ')');
          stepsHistory.slice().reverse().forEach((s, i) => {
            const detail = String(s.payload.path || s.payload.command || s.payload.url || s.payload.target || '').slice(0, 80);
            lines.push((i + 1) + '. ' + (s.action || '') + (detail ? ' ' + detail : '') + (s.reason ? ' — ' + String(s.reason).slice(0, 80) : ''));
            if (s.thought) lines.push('   Thought: ' + String(s.thought).slice(0, 150));
          });
          lines.push('');
        }
        if (info && info.logs && info.logs.length > 0) {
          lines.push('## Activity log');
          info.logs.slice(0, 40).forEach(l => {
            const t = l.type || l.action || 'log';
            const p = [l.path, l.url, l.command, l.target].filter(Boolean).join(' ');
            lines.push(t + (p ? ' ' + p.slice(0, 100) : ''));
          });
          lines.push('');
        }
        if (terminalHistory && terminalHistory.length > 0) {
          lines.push('## Terminal output');
          terminalHistory.forEach(te => {
            lines.push('$ ' + (te.command || ''));
            if (te.stdout) lines.push(te.stdout);
            if (te.stderr) lines.push('stderr: ' + te.stderr);
            lines.push('');
          });
        }
        const text = lines.join('\n');
        await navigator.clipboard.writeText(text);
        showToast('Copied — paste in Cursor so the AI can help fix or debug');
      } catch (e) {
        showToast('Copy failed: ' + (e.message || 'unknown'));
      }
    });
  }

  if (window.api.onChatThinking) {
    unsubscribes.push(window.api.onChatThinking((msg) => {
      const el = document.getElementById('chat-thinking-current');
      if (el && msg && msg.text) {
        el.textContent = msg.text;
        el.title = 'Laura\'s inner thought — part of the same mind';
      }
    }));
  }

  if (window.api.onStreamThought) {
    unsubscribes.push(window.api.onStreamThought((payload) => {
      const phase = (payload && payload.phase) || 'decision';
      const text = (payload && payload.text != null) ? String(payload.text) : '';
      const done = payload && payload.done === true;
      const streamEl = document.getElementById('live-thought-stream');
      const currentEl = document.getElementById('current-thought');
      const liveThoughtEl = document.getElementById('chat-live-thought');
      const chatThinkingEl = document.getElementById('chat-thinking-current');
      if (phase === 'decision' || phase === 'reflect') {
        if (streamEl) {
          streamEl.textContent = text;
          streamEl.style.display = text ? 'block' : 'none';
          streamEl.classList.toggle('streaming', !done);
        }
        if (done && currentEl) {
          currentEl.textContent = text ? text.slice(0, 500) : 'Idle';
          currentEl.classList.toggle('is-idle', !text);
        }
        if (done && liveThoughtEl) liveThoughtEl.textContent = text ? text.slice(0, 300) : '—';
        if (done && streamEl) streamEl.style.display = 'none';
      } else if (phase === 'chat') {
        if (chatThinkingEl) {
          chatThinkingEl.textContent = text;
          chatThinkingEl.classList.toggle('streaming', !done);
          chatThinkingEl.title = done ? '' : 'Laura is typing…';
          if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
        }
      }
    }));
  }

  if (window.api.onStreamAction) {
    unsubscribes.push(window.api.onStreamAction((payload) => {
      const previewEl = document.getElementById('stream-action-preview');
      if (!previewEl) return;
      if (payload && payload.done === true) {
        previewEl.style.display = 'none';
        previewEl.innerHTML = '';
        return;
      }
      if (payload && payload.type === 'edit_code' && payload.preview) {
        const path = (payload.path || '').slice(-60);
        const oldT = (payload.oldText || '').slice(0, 400);
        const newT = (payload.newText || '').slice(0, 400);
        previewEl.innerHTML =
          '<div class="diff-path">' + escapeHtml(path) + '</div>' +
          (oldT ? '<div class="diff-old">− ' + escapeHtml(oldT).replace(/\n/g, '<br>') + '</div>' : '') +
          (newT ? '<div class="diff-new">+ ' + escapeHtml(newT).replace(/\n/g, '<br>') + '</div>' : '');
        previewEl.style.display = 'block';
      }
    }));
  }

  async function sendChat() {
    if (!chatInput || !chatMessages) return;
    let text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';

    if (text.startsWith('/')) {
      const cmd = text.slice(1).split(/\s+/);
      const name = (cmd[0] || '').toLowerCase();
      if (name === 'goal' && cmd.length > 1) {
        const goalText = cmd.slice(1).join(' ').trim();
        if (goalText) {
          try {
            await window.api.setGoal(goalText);
            appendChatMessage('user', text, false);
            appendChatMessage('system', 'Goal set: ' + goalText, false);
            refreshGoals();
          } catch (_) {
            appendChatMessage('user', text, false);
            appendChatMessage('system', 'Could not set goal.', false);
          }
        }
        return;
      }
      if (name === 'think') {
        appendChatMessage('user', text, false);
        const thinkingEl = appendChatMessage('assistant', 'Running one step…', true);
        try {
          await window.api.thinkOnce();
          thinkingEl.remove();
          appendChatMessage('system', 'One think step completed. Check the Mind panel for her thought.', false);
        } catch (e) {
          thinkingEl.textContent = 'Step failed: ' + (e.message || 'error');
          thinkingEl.className = 'chat-msg system';
          thinkingEl.removeAttribute('id');
        }
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return;
      }
    }

    const startTime = Date.now();
    appendChatMessage('user', text, false);
    const thinkingEl = appendChatMessage('assistant', 'Working on it…', true);
    try {
      const { reply, fromModel, innerThought } = await window.api.sendChat(text);
      const thoughtMs = Date.now() - startTime;
      thinkingEl.remove();
      if (innerThought) appendStreamToChat('reasoning', 'Thinking', innerThought, thoughtMs);
      appendChatMessage('assistant', reply || 'No reply.', false);
      if (!fromModel) {
        const last = chatMessages.lastElementChild;
        if (last) last.className = 'chat-msg system';
      }
    } catch (e) {
      thinkingEl.textContent = 'Could not reach the model: ' + (e.message || 'error');
      thinkingEl.className = 'chat-msg system';
      thinkingEl.removeAttribute('id');
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  async function init() {
    const container = document.getElementById('scene-container');
    if (container && window.scene3d && window.scene3d.init) {
      window.scene3d.init(container);
      window.scene3d.resize();
    }
    try {
      const cfg = await window.api.getConfig();
      voiceEnabled = cfg.speakThoughts !== false;
      focusMode = cfg.focusMode === true;
      continuousMode = cfg.continuousMode === true;
      updateVoiceButton();
      updateFocusButton();
      updateContinuousButton();
    } catch (_) {}
    await refreshStats();
    await refreshThoughts();
    await refreshLogs();
    await refreshInnerThoughts();
    await refreshGoals();
    await loadChatHistory();
    setupChatResizer();
    try {
      const living = await window.api.getLivingState();
      if (living) {
        lastLivingState = { hormones: living.hormones || {}, emotions: living.emotions || {}, stats: living.stats || {}, living: living.living || {} };
        updateVitalsDrawer(lastLivingState);
        const st = living.loopStatus;
        if (statusDot && statusText) {
          statusDot.className = 'pulse ';
          const badge = document.getElementById('living-badge');
          if (st && st.paused) {
            statusDot.classList.add('pause');
            statusText.textContent = 'Paused';
            if (badge) { badge.textContent = 'PAUSED'; badge.className = 'living-badge paused'; }
          } else if (st && st.running) {
            statusDot.classList.add('run');
            statusText.textContent = 'Autonomous';
            if (badge) { badge.textContent = 'LIVING'; badge.className = 'living-badge'; }
          } else {
            statusDot.classList.add('stop');
            statusText.textContent = 'Stopped';
            if (badge) { badge.textContent = 'STOP'; badge.className = 'living-badge stop'; }
          }
        }
      }
    } catch (_) {}
    setInterval(() => refreshResourceLine(), 3000);
    setInterval(() => {
      const drawer = document.getElementById('vitals-drawer');
      if (drawer && drawer.classList.contains('open')) updateNextTickCountdown(lastLivingState.living?.lastTickTime, lastLivingState.living?.nextIntervalMs);
    }, 1000);
  }

  const btnVitalsToggle = document.getElementById('btn-vitals-toggle');
  const vitalsDrawer = document.getElementById('vitals-drawer');
  if (btnVitalsToggle && vitalsDrawer) {
    btnVitalsToggle.addEventListener('click', () => {
      vitalsDrawer.classList.toggle('open');
      vitalsDrawer.setAttribute('aria-hidden', vitalsDrawer.classList.contains('open') ? 'false' : 'true');
      if (vitalsDrawer.classList.contains('open')) updateVitalsDrawer();
    });
    document.addEventListener('click', (e) => {
      if (vitalsDrawer.classList.contains('open') && !vitalsDrawer.contains(e.target) && !btnVitalsToggle.contains(e.target)) {
        vitalsDrawer.classList.remove('open');
        vitalsDrawer.setAttribute('aria-hidden', 'true');
      }
    });
  }


  const goalInput = document.getElementById('goal-input');
  const goalAddBtn = document.getElementById('goal-add-btn');
  if (goalAddBtn && goalInput) {
    goalAddBtn.addEventListener('click', async () => {
      const text = goalInput.value.trim();
      if (!text) return;
      goalInput.value = '';
      try {
        await window.api.setGoal(text);
        refreshGoals();
      } catch (_) {}
    });
    goalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') goalAddBtn.click();
    });
  }

  const rail = document.getElementById('rail');
  const mainLayout = document.getElementById('main-layout');
  const railToggle = document.getElementById('rail-toggle');
  const railToggleRestore = document.getElementById('rail-toggle-restore');
  if (rail && mainLayout && railToggle) {
    railToggle.addEventListener('click', () => {
      rail.classList.add('collapsed');
      mainLayout.classList.add('rail-collapsed');
      railToggle.setAttribute('title', 'Show Mind panel');
      railToggle.setAttribute('aria-label', 'Show Mind panel');
    });
  }
  if (rail && mainLayout && railToggleRestore) {
    railToggleRestore.addEventListener('click', () => {
      rail.classList.remove('collapsed');
      mainLayout.classList.remove('rail-collapsed');
      const t = document.getElementById('rail-toggle');
      if (t) {
        t.setAttribute('title', 'Collapse panel');
        t.setAttribute('aria-label', 'Collapse panel');
      }
    });
  }

  document.querySelectorAll('.rail-main-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const railName = tab.dataset.rail;
      document.querySelectorAll('.rail-main-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      document.querySelectorAll('.rail-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const pane = document.getElementById('rail-' + railName);
      if (pane) pane.classList.add('active');
    });
  });

  const terminalTabsEl = document.getElementById('terminal-tabs');
  const terminalContentEl = document.getElementById('terminal-content');
  const terminalTabAddBtn = document.getElementById('terminal-tab-add');
  let terminalTabCount = 0;
  const terminalTabs = [{ id: 'laura', title: 'Laura', pane: terminalContentEl && terminalContentEl.querySelector('[data-terminal-id="laura"]') }];
  function addTerminalTab(title) {
    if (!terminalContentEl) return;
    terminalTabCount++;
    const id = 'pty-' + terminalTabCount;
    const pane = document.createElement('div');
    pane.className = 'terminal-tab-pane';
    pane.dataset.terminalId = id;
    pane.innerHTML = '<div class="terminal-pty-placeholder">PowerShell terminal — add node-pty + xterm for live shell</div>';
    terminalContentEl.appendChild(pane);
    const tabEl = document.createElement('div');
    tabEl.className = 'terminal-tab';
    tabEl.dataset.terminalId = id;
    tabEl.innerHTML = '<span class="terminal-tab-title">' + escapeHtml(title || 'PowerShell ' + terminalTabCount) + '</span><button type="button" class="terminal-tab-close" aria-label="Close">×</button>';
    const titleEl = tabEl.querySelector('.terminal-tab-title');
    const closeBtn = tabEl.querySelector('.terminal-tab-close');
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeTerminalTab(id); });
    tabEl.addEventListener('click', () => { switchTerminalTab(id); });
    terminalTabs.push({ id, title: title || ('PowerShell ' + terminalTabCount), pane, tabEl });
    if (terminalTabsEl) terminalTabsEl.appendChild(tabEl);
    switchTerminalTab(id);
  }
  function removeTerminalTab(id) {
    if (id === 'laura' || terminalTabs.length <= 1) return;
    const idx = terminalTabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const t = terminalTabs[idx];
    terminalTabs.splice(idx, 1);
    if (t.tabEl && t.tabEl.parentNode) t.tabEl.parentNode.removeChild(t.tabEl);
    if (t.pane && t.pane.parentNode) t.pane.parentNode.removeChild(t.pane);
    if (terminalTabs.length > 0) switchTerminalTab(terminalTabs[0].id);
  }
  function switchTerminalTab(id) {
    terminalTabs.forEach(t => {
      if (t.tabEl) t.tabEl.classList.toggle('active', t.id === id);
      if (t.pane) t.pane.classList.toggle('active', t.id === id);
    });
  }
  if (terminalTabsEl && terminalContentEl) {
    const lauraTab = document.createElement('div');
    lauraTab.className = 'terminal-tab active';
    lauraTab.dataset.terminalId = 'laura';
    lauraTab.innerHTML = '<span class="terminal-tab-title">Laura</span>';
    lauraTab.addEventListener('click', () => { switchTerminalTab('laura'); });
    terminalTabsEl.appendChild(lauraTab);
    terminalTabs[0].tabEl = lauraTab;
    if (terminalTabAddBtn) terminalTabAddBtn.addEventListener('click', () => addTerminalTab('PowerShell ' + (terminalTabCount + 1)));
  }

  function cleanup() {
    unsubscribes.forEach(fn => { try { fn(); } catch (_) {} });
    if (window.scene3d && typeof window.scene3d.cleanup === 'function') window.scene3d.cleanup();
  }
  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
