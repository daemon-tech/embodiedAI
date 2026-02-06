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

  function renderThought(t, isNew) {
    const el = document.createElement('div');
    el.className = 'item' + (isNew ? ' item-new' : '');
    el.innerHTML = `<time>${formatTime(t.t)}</time>${escapeHtml(t.text)}`;
    return el;
  }

  function renderLog(l) {
    const el = document.createElement('div');
    el.className = 'item';
    const payload = l.path || l.url || l.type || '';
    el.innerHTML = `<time>${formatTime(l.t)}</time> ${escapeHtml(l.type)} ${escapeHtml(payload)}`;
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
    if (!list) return;
    try {
      const goals = await window.api.getGoals();
      list.innerHTML = '';
      (goals || []).forEach(g => {
        const el = document.createElement('div');
        el.className = 'goal-item';
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
      arr.slice(0, 12).forEach((t, i) => {
        const el = document.createElement('div');
        el.className = 'inner-item' + (i === 0 ? ' inner-item-new' : '');
        el.textContent = t.text;
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
    if (!logsList) return;
    try {
      const list = await window.api.getLogs(80);
      logsList.innerHTML = '';
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
    if (currentThought) currentThought.textContent = text || '—';
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

  function updateHormoneBars(h) {
    if (!h) return;
    const pct = (v) => Math.round((v ?? 0.5) * 100);
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) {
        el.style.width = pct(v) + '%';
        const wrap = el.closest('.vital-bar') || el.closest('.h-bar');
        if (wrap) wrap.setAttribute('aria-valuenow', pct(v));
      }
    };
    set('bar-dopamine', h.dopamine);
    set('bar-cortisol', h.cortisol);
    set('bar-serotonin', h.serotonin);
    const fmt = (v) => (v ?? 0).toFixed(2);
    const setVal = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = fmt(v); };
    setVal('val-dopamine', h.dopamine);
    setVal('val-cortisol', h.cortisol);
    setVal('val-serotonin', h.serotonin);
    if (window.scene3d && window.scene3d.update) window.scene3d.update(h);
  }

  function updateVitalsDrawer(state) {
    if (!state) state = lastLivingState;
    const h = state.hormones || {};
    const e = state.emotions || {};
    const s = state.stats || {};
    const liv = state.living || {};
    const pct = (v) => Math.round((v ?? 0) * 100);
    const setBar = (id, v, color) => {
      const el = document.getElementById(id);
      if (el) { el.style.width = pct(v) + '%'; if (color) el.style.background = color; }
    };
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = (v ?? 0).toFixed(2); };
    setBar('dmini-d-fill', h.dopamine, '#3fb950'); setVal('v-dopamine', h.dopamine);
    setBar('dmini-c-fill', h.cortisol, '#f85149'); setVal('v-cortisol', h.cortisol);
    setBar('dmini-s-fill', h.serotonin, '#d29922'); setVal('v-serotonin', h.serotonin);
    setBar('emo-joy', e.joy, '#3fb950'); setVal('v-joy', e.joy);
    setBar('emo-interest', e.interest, '#d29922'); setVal('v-interest', e.interest);
    setBar('emo-frustration', e.frustration, '#f85149'); setVal('v-frustration', e.frustration);
    setBar('emo-confusion', e.confusion, '#9e9e9e'); setVal('v-confusion', e.confusion);
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

  unsubscribes.push(window.api.onThought((msg) => {
    setCurrentThought(msg);
    if (msg.hormones) updateHormoneBars(msg.hormones);
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

  unsubscribes.push(window.api.onHormones((h) => {
    updateHormoneBars(h);
    if (window.scene3d && window.scene3d.update) window.scene3d.update(h);
  }));

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

  if (window.api.onChatThinking) {
    unsubscribes.push(window.api.onChatThinking((msg) => {
      const el = document.getElementById('chat-thinking-current');
      if (el && msg && msg.text) {
        el.textContent = msg.text;
        el.title = 'Laura\'s inner thought — part of the same mind';
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
    try {
      const h = await window.api.getHormones();
      updateHormoneBars(h);
      if (window.scene3d && window.scene3d.update) window.scene3d.update(h);
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
        lastLivingState = { hormones: living.hormones, emotions: living.emotions, stats: living.stats, living: living.living };
        updateHormoneBars(living.hormones);
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

  function cleanup() {
    unsubscribes.forEach(fn => { try { fn(); } catch (_) {} });
    if (window.scene3d && typeof window.scene3d.cleanup === 'function') window.scene3d.cleanup();
  }
  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
