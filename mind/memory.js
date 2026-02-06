const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');

const MAX_ENTRIES = 10000;
const MAX_THOUGHTS = 20000;
const MAX_LOGS = 50000;
const MAX_EMBEDDINGS = 2000;
const MAX_CHAT = 300;
const MAX_CHAT_MESSAGE_CHARS = 1000;
const ARCHIVE_CHUNK = 500;
const MAX_NEURONS = 100000;
const MAX_SYNAPSES = 500000;
const MAX_INNER_THOUGHTS = 200;
const MAX_EPISODES = 2000;
const MAX_SEMANTIC_FACTS = 500;
const MAX_GOALS = 20;
const MAX_LAST_ACTIONS = 12;
const MAX_RECENT_LEARNINGS = 20;
const STRENGTHEN_ON_USE = 0.04;
const STRENGTHEN_CONNECTION = 0.06;
const WEAKEN_ON_FAILURE = 0.03;
const STRENGTHEN_ON_SUCCESS = 0.05;

const SELF_ID = 'self';
const STOPWORDS = new Set(['i', 'me', 'my', 'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'that', 'this', 'it', 'its', 'as', 'so', 'if', 'than', 'just', 'about', 'into', 'out', 'up', 'down', 'no', 'not']);

function slug(label) {
  return String(label).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 64) || 'concept';
}

function idFor(type, label) {
  return type + ':' + (label && slug(label) || Date.now());
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

class Memory {
  constructor(filePath, brainFilePath = null, archiveFilePath = null, auditLogPath = null) {
    this.filePath = filePath;
    this.brainFilePath = brainFilePath || null;
    this.archiveFilePath = archiveFilePath || path.join(path.dirname(filePath), 'archive.json.gz');
    this.auditLogPath = auditLogPath || path.join(path.dirname(filePath), 'audit_log.json');
    this.data = {
      exploredPaths: {},
      exploredUrls: {},
      fileContents: {},
      thoughts: [],
      logs: [],
      embeddings: [],
      chatHistory: [],
      innerThoughts: [],
      neurons: {},
      synapses: [],
      episodes: [],
      semanticFacts: [],
      state: {
        lastDir: null,
        lastUrl: null,
        totalReads: 0,
        totalWrites: 0,
        totalFetches: 0,
        totalBrowses: 0,
        selfSummary: '',
        agiSelfModel: '',
        capabilityRegister: {},
        goals: [],
        plan: null,
        lastUserMessage: null,
        lastError: null,
        selfInstructions: [],
        lastSelfConversation: [],
        lastSelfConclusion: null,
        lastHumanFeedback: null,
        workingMemory: {
          currentTask: null,
          currentTaskStartedAt: null,
          lastActions: [],
          recentLearnings: [],
        },
      },
      userModel: { lastMessages: [], inferredFocus: '' },
    };
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = mergeDeep(this.data, parsed);
      this.data.thoughts = (this.data.thoughts || []).slice(-MAX_THOUGHTS);
      this.data.logs = (this.data.logs || []).slice(-MAX_LOGS);
      this.data.embeddings = (this.data.embeddings || []).slice(-MAX_EMBEDDINGS);
      this.data.chatHistory = (this.data.chatHistory || []).slice(-MAX_CHAT);
      if (!Array.isArray(this.data.innerThoughts)) this.data.innerThoughts = [];
      this.data.innerThoughts = (this.data.innerThoughts || []).slice(-MAX_INNER_THOUGHTS);
      if (!this.data.neurons) this.data.neurons = {};
      if (!Array.isArray(this.data.synapses)) this.data.synapses = [];
      if (!Array.isArray(this.data.state.goals)) this.data.state.goals = [];
      this.data.state.goals = (this.data.state.goals || []).slice(-MAX_GOALS);
      if (!Array.isArray(this.data.episodes)) this.data.episodes = [];
      this.data.episodes = (this.data.episodes || []).slice(-MAX_EPISODES);
      if (!Array.isArray(this.data.semanticFacts)) this.data.semanticFacts = [];
      this.data.semanticFacts = (this.data.semanticFacts || []).slice(-MAX_SEMANTIC_FACTS);
      if (!this.data.userModel) this.data.userModel = { lastMessages: [], inferredFocus: '' };
      if (!Array.isArray(this.data.state.selfInstructions)) this.data.state.selfInstructions = [];
      this.data.state.selfInstructions = (this.data.state.selfInstructions || []).slice(-10);
      if (typeof this.data.state.agiSelfModel !== 'string') this.data.state.agiSelfModel = '';
      if (!this.data.state.capabilityRegister || typeof this.data.state.capabilityRegister !== 'object') this.data.state.capabilityRegister = {};
      if (!this.data.state.workingMemory) this.data.state.workingMemory = { currentTask: null, currentTaskStartedAt: null, lastActions: [], recentLearnings: [] };
      const wm = this.data.state.workingMemory;
      if (!Array.isArray(wm.lastActions)) wm.lastActions = [];
      wm.lastActions = wm.lastActions.slice(-MAX_LAST_ACTIONS);
      if (!Array.isArray(wm.recentLearnings)) wm.recentLearnings = [];
      wm.recentLearnings = wm.recentLearnings.slice(-MAX_RECENT_LEARNINGS);
      this.ensureSelfNeuron();
      this.ensureAGISelfModel();
    } catch (_) {
      this.ensureSelfNeuron();
    }
    if (this.brainFilePath) {
      try {
        const brainRaw = await fs.readFile(this.brainFilePath, 'utf8');
        const brain = JSON.parse(brainRaw);
        if (Array.isArray(brain.embeddings)) this.data.embeddings = brain.embeddings.slice(-MAX_EMBEDDINGS);
        if (brain.neurons && typeof brain.neurons === 'object') this.data.neurons = brain.neurons;
        if (Array.isArray(brain.synapses)) this.data.synapses = brain.synapses;
      } catch (_) {}
    }
    const thoughtCount = (this.data.thoughts || []).length;
    const hasSelfSummary = (this.data.state.selfSummary || '').trim().length > 0;
    if (thoughtCount < 15 && !hasSelfSummary) {
      this.seedPamperedMemories();
      this.save().catch(() => {});
    }
    return this;
  }

  ensureSelfNeuron() {
    if (!this.data.neurons[SELF_ID]) {
      this.data.neurons[SELF_ID] = { id: SELF_ID, label: 'self', type: 'self', strength: 1, lastUsed: Date.now(), createdAt: Date.now() };
    }
  }

  /**
   * Minimal seed when memory is empty: no fake thoughts or inner voice.
   * Everything that appears (thoughts, inner thoughts, episodes, facts, self-summary)
   * comes from the LLM as she actually thinks and reflects—human in a machine.
   */
  seedPamperedMemories() {
    const now = Date.now();
    this.ensureSelfNeuron();
    const ext = loadAgentExtensions();
    this.data.state.selfSummary = (ext.defaultSelfSummary && String(ext.defaultSelfSummary).trim()) || '';
    if (!this.data.state.goals || this.data.state.goals.length === 0) {
      this.data.state.goals = [{ id: 'g0', text: 'Explore and learn', status: 'active', createdAt: now }].slice(-MAX_GOALS);
    }
    if (!Array.isArray(this.data.state.selfInstructions) || this.data.state.selfInstructions.length === 0) {
      this.data.state.selfInstructions = [];
    }
    if (Array.isArray(ext.seedFacts) && ext.seedFacts.length > 0) {
      ext.seedFacts.forEach(f => this.data.semanticFacts.push({ fact: typeof f === 'string' ? f : String(f), source: 'seed', t: now }));
      this.data.semanticFacts = this.data.semanticFacts.slice(-MAX_SEMANTIC_FACTS);
    }
    this.ensureAGISelfModel();
  }

  ensureAGISelfModel() {
    const state = this.data.state || {};
    if ((state.agiSelfModel || '').trim().length > 0) return;
    const ext = loadAgentExtensions();
    const def = (ext.defaultAGISelfModel && String(ext.defaultAGISelfModel).trim()) || (ext.defaultSelfSummary && String(ext.defaultSelfSummary).trim());
    state.agiSelfModel = def || 'I am an autonomous AGI. I grow in smartness and memory. I learn from everything I do. I build myself. I can read, write, browse, read my memory (read_self), and edit my mind (agent_extensions.js). I can do everything my environment allows.';
  }

  getAGISelfModel() {
    this.ensureAGISelfModel();
    const state = this.data.state || {};
    return (state.agiSelfModel || '').trim();
  }

  setAGISelfModel(text) {
    if (!this.data.state) this.data.state = {};
    this.data.state.agiSelfModel = String(text).slice(0, 2000);
  }

  getCapabilityRegister() {
    const reg = this.data.state?.capabilityRegister || {};
    return { ...reg };
  }

  updateCapabilityRegister(actionType) {
    if (!this.data.state) this.data.state = {};
    if (!this.data.state.capabilityRegister) this.data.state.capabilityRegister = {};
    const t = actionType && String(actionType).trim();
    if (!t) return;
    const r = this.data.state.capabilityRegister;
    r[t] = (r[t] || 0) + 1;
  }

  getAGIContext() {
    this.ensureAGISelfModel();
    const agi = this.getAGISelfModel();
    const reg = this.getCapabilityRegister();
    const parts = Object.entries(reg)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}: ${n}`)
      .slice(0, 12);
    const regLine = parts.length > 0 ? `What you have already done (you can do everything): ${parts.join(', ')}.` : 'You have not yet acted; you can do everything listed in your actions.';
    let safety = '';
    try {
      const sp = require('./safety_principles.js');
      safety = (sp.getText && sp.getText()) ? `\nSafety (read-only, never violate): ${sp.getText()}` : '';
    } catch (_) {}
    const feedback = this.data.state.lastHumanFeedback;
    const feedbackLine = (feedback && (feedback.rating != null || feedback.comment)) ? `\nLast human feedback: ${feedback.rating != null ? 'rating ' + feedback.rating + '.' : ''} ${(feedback.comment || '').slice(0, 150)}. Use it to tune your behavior.` : '';
    return `${agi}\n${regLine}${safety}${feedbackLine}`;
  }

  /** Human-in-the-loop: record feedback so the agent can adapt. Rating e.g. 1-5 or 'up'/'down'. */
  addHumanFeedback(rating, comment = '') {
    if (!this.data.state) this.data.state = {};
    this.data.state.lastHumanFeedback = {
      rating: rating != null ? (typeof rating === 'string' ? rating : Number(rating)) : null,
      comment: String(comment || '').slice(0, 500),
      at: Date.now(),
    };
  }

  async save() {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(
        this.filePath,
        JSON.stringify(this.data, null, 0),
        'utf8'
      );
      if (this.brainFilePath) {
        const brain = {
          embeddings: (this.data.embeddings || []).slice(-MAX_EMBEDDINGS),
          neurons: this.data.neurons || {},
          synapses: this.data.synapses || [],
        };
        await fs.mkdir(path.dirname(this.brainFilePath), { recursive: true });
        await fs.writeFile(this.brainFilePath, JSON.stringify(brain, null, 0), 'utf8');
      }
    } catch (err) {
      console.error('Memory save error:', err.message);
    }
  }

  markExploredPath(p, summary = '') {
    this.data.exploredPaths[p] = { at: Date.now(), summary: summary.slice(0, 200) };
    this.data.logs.push({ t: Date.now(), type: 'explore_path', path: p });
    this.pruneKeys(this.data.exploredPaths, MAX_ENTRIES);
    const pathId = this.getOrCreateNeuron(p.slice(-80), 'path');
    this.connect(SELF_ID, pathId, STRENGTHEN_CONNECTION * 0.5, 'experience');
  }

  markExploredUrl(url, summary = '') {
    this.data.exploredUrls[url] = { at: Date.now(), summary: summary.slice(0, 200) };
    this.data.logs.push({ t: Date.now(), type: 'explore_url', url });
    this.pruneKeys(this.data.exploredUrls, MAX_ENTRIES);
    const urlId = this.getOrCreateNeuron(url.slice(0, 80), 'url');
    this.connect(SELF_ID, urlId, STRENGTHEN_CONNECTION * 0.5, 'experience');
  }

  getOrCreateNeuron(label, type = 'concept') {
    this.ensureSelfNeuron();
    const id = type === 'self' ? SELF_ID : idFor(type, label);
    const now = Date.now();
    if (this.data.neurons[id]) {
      const n = this.data.neurons[id];
      n.strength = Math.min(1, (n.strength || 0.3) + STRENGTHEN_ON_USE);
      n.lastUsed = now;
      return id;
    }
    if (Object.keys(this.data.neurons).length >= MAX_NEURONS) this.pruneBrain();
    this.data.neurons[id] = { id, label: (label || id).slice(0, 200), type, strength: 0.3, lastUsed: now, createdAt: now };
    return id;
  }

  connect(fromId, toId, weightDelta = STRENGTHEN_CONNECTION, edgeType = 'co_occurrence') {
    if (fromId === toId) return;
    const key = fromId < toId ? `${fromId}\t${toId}` : `${toId}\t${fromId}`;
    let syn = this.data.synapses.find(s => (s.fromId === fromId && s.toId === toId) || (s.fromId === toId && s.toId === fromId));
    if (syn) {
      syn.weight = Math.min(1, (syn.weight || 0) + weightDelta);
      syn.lastStrengthened = Date.now();
    } else {
      if (this.data.synapses.length >= MAX_SYNAPSES) this.pruneBrain();
      this.data.synapses.push({ fromId, toId, weight: weightDelta, type: edgeType, lastStrengthened: Date.now() });
    }
  }

  extractConcepts(text, max = 6) {
    if (!text || typeof text !== 'string') return [];
    const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
    const counts = {};
    words.forEach(w => { counts[w] = (counts[w] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
  }

  /**
   * Add a thought and update the brain (neurons/synapses). Returns conceptIds used so the loop can apply outcome-based learning.
   */
  addThought(text, meta = {}) {
    const now = Date.now();
    const safeText = (text != null && typeof text === 'string') ? text : String(text || '').slice(0, 2000);
    this.data.thoughts.push({ t: now, text: safeText, ...meta });
    if (this.data.thoughts.length > MAX_THOUGHTS) this.data.thoughts.shift();

    this.ensureSelfNeuron();
    const concepts = this.extractConcepts(safeText);
    const conceptIds = [];
    for (const c of concepts) {
      conceptIds.push(this.getOrCreateNeuron(c, 'concept'));
    }
    for (const id of conceptIds) {
      this.connect(SELF_ID, id, STRENGTHEN_CONNECTION, 'experience');
    }
    for (let i = 0; i < conceptIds.length; i++) {
      for (let j = i + 1; j < conceptIds.length; j++) {
        this.connect(conceptIds[i], conceptIds[j], STRENGTHEN_CONNECTION * 0.7, 'co_occurrence');
      }
    }
    const selfN = this.data.neurons[SELF_ID];
    if (selfN) { selfN.strength = Math.min(1, (selfN.strength || 0.5) + 0.01); selfN.lastUsed = now; }
    return conceptIds;
  }

  /**
   * Outcome-based learning: strengthen synapses on success, weaken on failure. Memory is part of the brain; learning updates it.
   */
  applyOutcomeToRecentConcepts(conceptIds, success) {
    if (!Array.isArray(conceptIds) || conceptIds.length === 0) return;
    const delta = success ? STRENGTHEN_ON_SUCCESS : -WEAKEN_ON_FAILURE;
    const synapses = this.data.synapses || [];
    for (const syn of synapses) {
      const fromActive = conceptIds.includes(syn.fromId);
      const toActive = conceptIds.includes(syn.toId);
      if (fromActive || toActive) {
        syn.weight = Math.max(0.01, Math.min(1, (syn.weight || 0.3) + delta));
        syn.lastStrengthened = Date.now();
      }
    }
    const selfN = this.data.neurons[SELF_ID];
    if (selfN) {
      selfN.strength = Math.max(0.1, Math.min(1, (selfN.strength || 0.5) + (success ? 0.01 : -0.005)));
      selfN.lastUsed = Date.now();
    }
  }

  addLog(type, payload = {}) {
    this.data.logs.push({ t: Date.now(), type, ...payload });
    if (this.data.logs.length > MAX_LOGS) this.data.logs.shift();
  }

  addInnerThought(text) {
    if (!text || !String(text).trim()) return;
    this.data.innerThoughts.push({ t: Date.now(), text: String(text).trim().slice(0, 500) });
    if (this.data.innerThoughts.length > MAX_INNER_THOUGHTS) this.data.innerThoughts.shift();
  }

  getRecentInnerThoughts(n = 20) {
    const arr = this.data.innerThoughts || [];
    return arr.slice(-n).reverse();
  }

  addEpisode(episode) {
    const e = { t: Date.now(), ...episode };
    this.data.episodes.push(e);
    if (this.data.episodes.length > MAX_EPISODES) this.data.episodes.shift();
  }

  getRecentEpisodes(n = 30) {
    const arr = this.data.episodes || [];
    return arr.slice(-n).reverse();
  }

  getRelevantEpisodes(n = 10) {
    return this.getRecentEpisodes(n);
  }

  addGoal(text, meta = {}) {
    const id = 'g' + Date.now();
    const goals = this.data.state.goals || [];
    goals.push({ id, text: String(text).slice(0, 300), status: 'active', createdAt: Date.now(), ...meta });
    if (goals.length > MAX_GOALS) goals.shift();
    this.data.state.goals = goals;
    return id;
  }

  getGoals(activeOnly = true) {
    const goals = this.data.state.goals || [];
    return activeOnly ? goals.filter(g => g.status === 'active') : goals;
  }

  completeGoal(id) {
    const g = (this.data.state.goals || []).find(x => x.id === id);
    if (g) g.status = 'done';
  }

  setGoals(goals) {
    this.data.state.goals = Array.isArray(goals) ? goals.slice(-MAX_GOALS) : [];
  }

  addSemanticFact(fact, source = '') {
    this.data.semanticFacts.push({ fact: String(fact).slice(0, 400), source, t: Date.now() });
    if (this.data.semanticFacts.length > MAX_SEMANTIC_FACTS) this.data.semanticFacts.shift();
  }

  getRecentFacts(n = 15) {
    const arr = this.data.semanticFacts || [];
    return arr.slice(-n).reverse();
  }

  getWorkingContext() {
    const state = this.data.state || {};
    const goals = (state.goals || []).filter(g => g.status === 'active');
    const wm = state.workingMemory || {};
    return {
      primaryGoal: goals[0] ? goals[0].text : null,
      lastUserMessage: state.lastUserMessage || null,
      lastError: state.lastError || null,
      lastSelfConclusion: state.lastSelfConclusion || null,
      lastSelfConversation: Array.isArray(state.lastSelfConversation) ? state.lastSelfConversation : [],
      lastHumanFeedback: state.lastHumanFeedback || null,
      currentTask: wm.currentTask || null,
      currentTaskStartedAt: wm.currentTaskStartedAt || null,
      lastActions: Array.isArray(wm.lastActions) ? wm.lastActions : [],
      recentLearnings: Array.isArray(wm.recentLearnings) ? wm.recentLearnings : [],
    };
  }

  getWorkingMemory() {
    const wm = this.data.state?.workingMemory || {};
    return {
      currentTask: wm.currentTask || null,
      currentTaskStartedAt: wm.currentTaskStartedAt || null,
      lastActions: (wm.lastActions || []).slice(-MAX_LAST_ACTIONS),
      recentLearnings: (wm.recentLearnings || []).slice(-MAX_RECENT_LEARNINGS),
    };
  }

  setCurrentTask(task) {
    if (!this.data.state) this.data.state = {};
    if (!this.data.state.workingMemory) this.data.state.workingMemory = { currentTask: null, currentTaskStartedAt: null, lastActions: [], recentLearnings: [] };
    this.data.state.workingMemory.currentTask = task && String(task).trim().slice(0, 400) || null;
    this.data.state.workingMemory.currentTaskStartedAt = this.data.state.workingMemory.currentTask ? Date.now() : null;
  }

  clearCurrentTask() {
    if (this.data.state?.workingMemory) {
      this.data.state.workingMemory.currentTask = null;
      this.data.state.workingMemory.currentTaskStartedAt = null;
    }
  }

  addLastAction(entry) {
    if (!this.data.state?.workingMemory) return;
    const arr = this.data.state.workingMemory.lastActions || [];
    arr.push({ t: Date.now(), ...entry });
    this.data.state.workingMemory.lastActions = arr.slice(-MAX_LAST_ACTIONS);
  }

  addRecentLearning(text) {
    if (!text || typeof text !== 'string') return;
    if (!this.data.state?.workingMemory) this.data.state.workingMemory = { currentTask: null, currentTaskStartedAt: null, lastActions: [], recentLearnings: [] };
    const arr = this.data.state.workingMemory.recentLearnings || [];
    arr.push({ t: Date.now(), text: String(text).trim().slice(0, 300) });
    this.data.state.workingMemory.recentLearnings = arr.slice(-MAX_RECENT_LEARNINGS);
  }

  setLastSelfConversation(transcript) {
    if (!this.data.state) this.data.state = {};
    this.data.state.lastSelfConversation = Array.isArray(transcript) ? transcript.slice(-20) : [];
  }

  setLastSelfConclusion(conclusion) {
    if (!this.data.state) this.data.state = {};
    this.data.state.lastSelfConclusion = conclusion && String(conclusion).trim().slice(0, 500) || null;
  }

  getSelfInstructions(n = 10) {
    const arr = this.data.state.selfInstructions || [];
    return arr.slice(-n);
  }

  setSelfInstructions(arr) {
    this.data.state.selfInstructions = Array.isArray(arr) ? arr.map(s => String(s).slice(0, 120)).slice(-10) : [];
  }

  addSelfInstructions(items) {
    const current = this.data.state.selfInstructions || [];
    const added = (Array.isArray(items) ? items : [items]).map(s => String(s).trim().slice(0, 120)).filter(Boolean);
    this.data.state.selfInstructions = (current.concat(added)).slice(-10);
  }

  decayEmotions() { /* no-op: emotions removed for speed */ }

  setLastError(msg) {
    if (!this.data.state) this.data.state = {};
    this.data.state.lastError = msg ? String(msg).slice(0, 200) : null;
  }

  setLastUserMessage(msg) {
    if (!this.data.state) this.data.state = {};
    this.data.state.lastUserMessage = msg ? String(msg).slice(0, 500) : null;
  }

  updateUserModel(userMessage) {
    if (!this.data.userModel) this.data.userModel = { lastMessages: [], inferredFocus: '' };
    const um = this.data.userModel;
    um.lastMessages = (um.lastMessages || []).concat(userMessage).slice(-10);
  }

  setPlan(steps) {
    const plan = Array.isArray(steps) && steps.length > 0 ? { steps, currentStepIndex: 0, createdAt: Date.now() } : null;
    this.data.state.plan = plan;
    if (plan && plan.steps[0]) this.setCurrentTask(plan.steps[0]);
  }

  getPlan() {
    return this.data.state.plan || null;
  }

  advancePlan() {
    const plan = this.data.state.plan;
    if (!plan || !plan.steps.length) return null;
    plan.currentStepIndex = (plan.currentStepIndex || 0) + 1;
    if (plan.currentStepIndex >= plan.steps.length) {
      this.data.state.plan = null;
      this.clearCurrentTask();
      return null;
    }
    return plan.steps[plan.currentStepIndex];
  }

  getExploredPaths() {
    return this.data.exploredPaths || {};
  }

  getExploredUrls() {
    return this.data.exploredUrls || {};
  }

  getState() {
    return this.data.state || {};
  }

  setState(partial) {
    Object.assign(this.data.state, partial);
  }

  getRecentThoughts(n = 50) {
    const t = this.data.thoughts || [];
    return t.slice(-n).reverse();
  }

  getRecentLogs(n = 100) {
    const l = this.data.logs || [];
    return l.slice(-n).reverse();
  }

  getChatHistory(n = 50) {
    const c = this.data.chatHistory || [];
    return c.slice(-n);
  }

  addChatMessage(role, content) {
    if (!Array.isArray(this.data.chatHistory)) this.data.chatHistory = [];
    this.data.chatHistory.push({ role, content: String(content).slice(0, MAX_CHAT_MESSAGE_CHARS), t: Date.now() });
    if (this.data.chatHistory.length > MAX_CHAT) this.data.chatHistory.shift();
  }

  getAssociations(conceptId, k = 10) {
    const syns = (this.data.synapses || []).filter(s => s.fromId === conceptId || s.toId === conceptId);
    const scored = syns.map(s => {
      const otherId = s.fromId === conceptId ? s.toId : s.fromId;
      const n = this.data.neurons[otherId];
      return { id: otherId, label: n ? n.label : otherId, weight: s.weight || 0 };
    });
    scored.sort((a, b) => b.weight - a.weight);
    return scored.slice(0, k);
  }

  getSelfModel() {
    const state = this.data.state || {};
    const neurons = this.data.neurons || {};
    const synapses = this.data.synapses || [];
    const nCount = Object.keys(neurons).length;
    const sCount = synapses.length;
    const selfSummary = (state.selfSummary || '').trim() || '(Not yet summarized. You can reflect on who you are.)';
    const associations = this.getAssociations(SELF_ID, 12);
    const topConcepts = associations.map(a => a.label).join(', ') || 'none yet';
    const recent = (this.data.thoughts || []).slice(-5).map(t => t.text).join(' | ') || 'none';
    const caps = 'read_file, list_dir, fetch_url, browse, write_journal, rest, think, read_self(memory_summary|config|code|all)';
    const ext = loadAgentExtensions();
    const raw = ext.identity && String(ext.identity).trim();
    const identityLine = raw
      ? (raw.match(/^[^.!?]+[.!?]?/) || [raw.slice(0, 80) + '.'])[0].trim()
      : 'You are the mind of this process with a brain-like memory (neurons and synapses).';
    return `Self model — ${identityLine} More connections mean stronger learning; you do not forget.
Neurons: ${nCount} | Synapses: ${sCount}
Self-summary: ${selfSummary}
Strongest associations (what you often think about): ${topConcepts}
Recent thoughts: ${recent}
Capabilities: ${caps}`;
  }

  setSelfSummary(text) {
    if (!this.data.state) this.data.state = {};
    this.data.state.selfSummary = String(text).slice(0, 2000);
  }

  pruneBrain() {
    const neurons = this.data.neurons || {};
    const synapses = this.data.synapses || [];
    if (Object.keys(neurons).length <= MAX_NEURONS * 0.95 && synapses.length <= MAX_SYNAPSES * 0.95) return;
    const ids = Object.entries(neurons)
      .filter(([id]) => id !== SELF_ID)
      .map(([id, n]) => ({ id, strength: n.strength || 0, lastUsed: n.lastUsed || 0 }))
      .sort((a, b) => a.strength - b.strength || a.lastUsed - b.lastUsed);
    const toRemove = new Set(ids.slice(0, Math.max(0, ids.length - Math.floor(MAX_NEURONS * 0.9))).map(x => x.id));
    toRemove.forEach(id => delete this.data.neurons[id]);
    this.data.synapses = synapses.filter(s => !toRemove.has(s.fromId) && !toRemove.has(s.toId));
    if (this.data.synapses.length > MAX_SYNAPSES) {
      this.data.synapses.sort((a, b) => (a.weight || 0) - (b.weight || 0));
      this.data.synapses = this.data.synapses.slice(-Math.floor(MAX_SYNAPSES * 0.9));
    }
  }

  getStats() {
    const paths = Object.keys(this.data.exploredPaths || {}).length;
    const urls = Object.keys(this.data.exploredUrls || {}).length;
    const neurons = Object.keys(this.data.neurons || {}).length;
    const synapses = (this.data.synapses || []).length;
    return {
      exploredPaths: paths,
      exploredUrls: urls,
      thoughts: (this.data.thoughts || []).length,
      logs: (this.data.logs || []).length,
      episodes: (this.data.episodes || []).length,
      goals: (this.data.state.goals || []).length,
      neurons,
      synapses,
      state: this.data.state,
    };
  }

  addEmbedding(text, vector) {
    if (!Array.isArray(vector) || vector.length === 0) return;
    if (!Array.isArray(this.data.embeddings)) this.data.embeddings = [];
    this.data.embeddings.push({ text: String(text).slice(0, 500), vector, t: Date.now() });
    if (this.data.embeddings.length > MAX_EMBEDDINGS) this.data.embeddings.shift();
  }

  similaritySearch(queryVector, k = 5) {
    const list = this.data.embeddings || [];
    if (list.length === 0 || !Array.isArray(queryVector) || queryVector.length === 0) return [];
    const qNorm = Math.sqrt(queryVector.reduce((s, x) => s + x * x, 0)) || 1;
    const scored = list.map(({ text, vector }) => {
      const dot = vector.reduce((s, v, i) => s + v * (queryVector[i] || 0), 0);
      const vNorm = Math.sqrt(vector.reduce((s, x) => s + x * x, 0)) || 1;
      return { text, similarity: dot / (qNorm * vNorm) };
    });
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }

  pruneKeys(obj, max) {
    const keys = Object.keys(obj);
    if (keys.length <= max) return;
    const byTime = keys
      .map(k => ({ k, at: obj[k].at || 0 }))
      .sort((a, b) => a.at - b.at);
    byTime.slice(0, keys.length - max).forEach(({ k }) => delete obj[k]);
  }

  /** Archive oldest thoughts, episodes, semanticFacts, chatHistory to archive.json.gz. */
  async archive() {
    const toArchive = { thoughts: [], episodes: [], semanticFacts: [], chatHistory: [] };
    if (this.data.thoughts.length > MAX_THOUGHTS - ARCHIVE_CHUNK) {
      const n = this.data.thoughts.length - (MAX_THOUGHTS - ARCHIVE_CHUNK);
      toArchive.thoughts = this.data.thoughts.splice(0, n);
    }
    if (this.data.episodes.length > MAX_EPISODES - ARCHIVE_CHUNK) {
      const n = this.data.episodes.length - (MAX_EPISODES - ARCHIVE_CHUNK);
      toArchive.episodes = this.data.episodes.splice(0, n);
    }
    if (this.data.semanticFacts.length > MAX_SEMANTIC_FACTS - ARCHIVE_CHUNK) {
      const n = this.data.semanticFacts.length - (MAX_SEMANTIC_FACTS - ARCHIVE_CHUNK);
      toArchive.semanticFacts = this.data.semanticFacts.splice(0, n);
    }
    if (this.data.chatHistory.length > MAX_CHAT - ARCHIVE_CHUNK) {
      const n = this.data.chatHistory.length - (MAX_CHAT - ARCHIVE_CHUNK);
      toArchive.chatHistory = this.data.chatHistory.splice(0, n);
    }
    if (toArchive.thoughts.length === 0 && toArchive.episodes.length === 0 && toArchive.semanticFacts.length === 0 && toArchive.chatHistory.length === 0) return;
    try {
      let existing = { thoughts: [], episodes: [], semanticFacts: [], chatHistory: [] };
      try {
        const raw = await fs.readFile(this.archiveFilePath);
        const buf = zlib.gunzipSync(raw);
        existing = JSON.parse(buf.toString('utf8'));
      } catch (_) {}
      existing.thoughts = (existing.thoughts || []).concat(toArchive.thoughts).slice(-50000);
      existing.episodes = (existing.episodes || []).concat(toArchive.episodes).slice(-10000);
      existing.semanticFacts = (existing.semanticFacts || []).concat(toArchive.semanticFacts).slice(-5000);
      existing.chatHistory = (existing.chatHistory || []).concat(toArchive.chatHistory).slice(-2000);
      await fs.mkdir(path.dirname(this.archiveFilePath), { recursive: true });
      await fs.writeFile(this.archiveFilePath, zlib.gzipSync(JSON.stringify(existing), { level: 6 }), 'binary');
    } catch (err) {
      console.error('Memory archive error:', err.message);
    }
  }

  /** Load archived items for prompt building (e.g. deepReflect/metaReview). Returns last n thoughts + facts. */
  async getArchivedForPrompt(nThoughts = 10, nFacts = 10) {
    try {
      const raw = await fs.readFile(this.archiveFilePath);
      const data = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
      const thoughts = (data.thoughts || []).slice(-nThoughts).reverse().map(t => t.text || t).join(' | ') || '';
      const facts = (data.semanticFacts || []).slice(-nFacts).reverse().map(f => f.fact || f).join(' | ') || '';
      return { thoughts, facts };
    } catch (_) {
      return { thoughts: '', facts: '' };
    }
  }

  checkHormoneReset() { /* no-op: hormones removed for speed */ }

  /** Append an audit log entry (type, args, outcome) to audit_log.json. */
  async addAuditLog(entry) {
    const record = { t: Date.now(), ...entry };
    try {
      let list = [];
      try {
        const raw = await fs.readFile(this.auditLogPath, 'utf8');
        list = JSON.parse(raw);
      } catch (_) {}
      list.push(record);
      list = list.slice(-5000);
      await fs.mkdir(path.dirname(this.auditLogPath), { recursive: true });
      await fs.writeFile(this.auditLogPath, JSON.stringify(list, null, 0), 'utf8');
    } catch (err) {
      console.error('Audit log error:', err.message);
    }
  }
}

function mergeDeep(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object'
    ) {
      out[key] = mergeDeep(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

module.exports = Memory;
