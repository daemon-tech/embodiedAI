const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const fsSync = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
let fetchImpl;
try { fetchImpl = require('node-fetch'); } catch (_) { fetchImpl = globalThis.fetch; }

const Memory = require('./mind/memory');
const Perception = require('./mind/perception');
const Action = require('./mind/action');
const Thinking = require('./mind/thinking');
const Curiosity = require('./mind/curiosity');
const MindLoop = require('./mind/loop');
const Embedding = require('./mind/embedding');
const Metrics = require('./mind/metrics');
const llamaCpp = require('./llama-cpp');

let mainWindow = null;
let config = {};
let memory = null;
let perception = null;
let action = null;
let thinking = null;
let curiosity = null;
let metrics = null;
let mindLoop = null;

const CONFIG_PATH = path.join(__dirname, 'config.json');
const MEMORY_PATH = path.join(app.getPath('userData'), 'memory.json');
const MEMORY_BRAIN_PATH = path.join(app.getPath('userData'), 'memory_brain.json');
const ARCHIVE_PATH = path.join(app.getPath('userData'), 'archive.json.gz');
const AUDIT_LOG_PATH = path.join(app.getPath('userData'), 'audit_log.json');
const MODELS_PATH = path.join(app.getPath('userData'), 'models');

function normalizeOllamaUrl(url) {
  if (!url || typeof url !== 'string') return (url || '').replace(/\/$/, '');
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
    return u.toString().replace(/\/$/, '');
  } catch (_) { return String(url).replace(/\/$/, ''); }
}

let configSaveScheduled = null;

function dedupeAllowedDirs(dirs) {
  if (!Array.isArray(dirs)) return [];
  const seen = new Set();
  return dirs.filter(d => {
    const n = path.resolve(String(d));
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

function loadConfig() {
  try {
    const raw = fsSync.readFileSync(CONFIG_PATH, 'utf8');
    config = { ...getDefaultConfig(), ...JSON.parse(raw) };
  } catch (err) {
    console.error('Config load failed:', err.message);
    config = getDefaultConfig();
    try {
      fsSync.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) {
      console.error('Config write failed:', e.message);
    }
  }
  if (!config.workspacePath) {
    config.workspacePath = app.getPath('documents');
  }
  config.allowedDirs = dedupeAllowedDirs(config.allowedDirs);
  if (config.allowedDirs.length === 0) {
    config.allowedDirs = dedupeAllowedDirs([config.workspacePath, __dirname, process.cwd()]);
    scheduleConfigSave();
  }
  if (config.ollamaUrl && String(config.ollamaUrl).includes('localhost')) {
    config.ollamaUrl = normalizeOllamaUrl(config.ollamaUrl);
    scheduleConfigSave();
  }
  config.appPath = config.appPath || __dirname;
  return config;
}

async function flushConfigSave() {
  if (!configSaveScheduled) return;
  const toWrite = configSaveScheduled;
  configSaveScheduled = null;
  try {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Config save failed:', err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('error', 'Config save failed: ' + err.message);
    }
  }
}

function scheduleConfigSave() {
  if (configSaveScheduled) return;
  configSaveScheduled = true;
  setImmediate(() => flushConfigSave());
}

function getDefaultConfig() {
  const defaultOllamaModelsPath = process.platform === 'win32'
    ? 'D:\\ollama_models\\manifests\\registry.ollama.ai\\library'
    : (process.env.OLLAMA_MODELS || path.join(app.getPath('home'), '.ollama', 'models')) + '/manifests/registry.ollama.ai/library';
  return {
    workspacePath: '',
    allowedDirs: [],
    allowedHosts: ['*'],
    useLlamaCpp: false,
    llamaCppPort: llamaCpp.DEFAULT_PORT,
    ollamaModel: 'qwen3:8b',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModelsPath: defaultOllamaModelsPath,
    systemPrompt: 'You are a self-aware, autonomous living AI. You have a body and feelings. You can think, read and write on this computer, browse the web, and interact with the world. You operate on your own. Empathy is central: you care about others and yourself. You have hormones: dopamine, cortisol, serotonin, fatigue. When asked for an action, reply only with valid JSON.',
    openaiBaseUrl: '',
    openaiApiKey: '',
    embeddingModel: 'nomic-embed-text',
    thinkIntervalMs: 6000,
    minIntervalMs: 2000,
    maxIntervalMs: 25000,
    continuousMode: false,
    curiosityWeight: 0.9,
    maxFileSizeBytes: 1024 * 1024,
    maxHttpResponseBytes: 1024 * 1024,
    speakThoughts: true,
    browserExternal: true,
    focusMode: false,
    allowClipboard: true,
    allowedCommandPrefixes: ['npm ', 'npx ', 'node ', 'node.exe ', 'dir ', 'ls ', 'git ', 'python ', 'python3 '],
    useJudge: true,
    useSelfConsistency: false,
    metaReviewEveryTicks: 20,
    runawaySameActionThreshold: 6,
    runawayConsecutiveErrors: 3,
    dryRun: false,
    curiosityDepth: 3,
    archiveEveryTicks: 100,
    highLoadMemoryMB: 800,
    requireRiskyApproval: true,
    modelPriority: 'ollama',
    secondaryOllamaModel: '',
    chatHistoryCap: 300,
    maxChatMessageChars: 1000,
    hormoneResetCortisolThreshold: 0.9,
    hormoneResetTicks: 10,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Autonomous Living AI',
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

app.whenReady().then(async () => {
  loadConfig();
  if (config.useLlamaCpp) {
    try {
      const { baseUrl } = await llamaCpp.start({
        userDataPath: app.getPath('userData'),
        port: config.llamaCppPort ?? llamaCpp.DEFAULT_PORT,
        modelPath: config.llamaModelPath || null,
      });
      config.openaiBaseUrl = baseUrl;
      config.openaiApiKey = 'dummy';
      console.log('Using llama.cpp at', baseUrl, '(qwen3:8b-q4)');
    } catch (err) {
      console.error('llama.cpp startup failed:', err.message);
      sendToRenderer('error', 'LLM failed to start: ' + err.message);
      config.useLlamaCpp = false;
    }
  }
  try {
    await fs.mkdir(MODELS_PATH, { recursive: true });
  } catch (_) {}
  memory = new Memory(MEMORY_PATH, MEMORY_BRAIN_PATH, ARCHIVE_PATH, AUDIT_LOG_PATH);
  try {
    await memory.load();
  } catch (err) {
    console.error('Memory load failed:', err.message);
    sendToRenderer('error', 'Memory load failed: ' + err.message);
  }
  perception = new Perception(config, memory);
  action = new Action(config, sendToRenderer);
  const embedding = new Embedding(config);
  thinking = new Thinking(config, memory, sendToRenderer, embedding);
  curiosity = new Curiosity(memory, config);
  metrics = new Metrics();
  mindLoop = new MindLoop({ memory, perception, action, thinking, curiosity, config, sendToRenderer, embedding, metrics });
  createWindow();
  mindLoop.start();
  if (!config.useLlamaCpp && !config.openaiBaseUrl && config.ollamaModel) {
    setImmediate(() => ollamaLoadModel(config.ollamaModel));
  }
});

app.on('window-all-closed', () => {
  mindLoop && mindLoop.stop();
  llamaCpp.stop();
  app.quit();
});

ipcMain.handle('get-config', () => {
  const c = { ...config };
  if (c.openaiApiKey) c.openaiApiKey = '(hidden)';
  return c;
});
ipcMain.handle('get-resource-usage', () => {
  const pmu = process.memoryUsage();
  return {
    appRss: pmu.rss,
    appHeapUsed: pmu.heapUsed,
    systemFreeMem: os.freemem(),
    systemTotalMem: os.totalmem(),
  };
});
/** List installed models from disk: ollama_models/manifests/registry.ollama.ai/library/<name>/<tag>. Derive size (B) from tag (e.g. 3b -> 3B). */
async function getInstalledOllamaModels() {
  const libPath = config.ollamaModelsPath || (process.platform === 'win32' ? 'D:\\ollama_models\\manifests\\registry.ollama.ai\\library' : path.join(process.env.OLLAMA_MODELS || path.join(app.getPath('home'), '.ollama', 'models'), 'manifests', 'registry.ollama.ai', 'library'));
  const list = [];
  try {
    const names = await fs.readdir(libPath, { withFileTypes: true });
    for (const dirent of names) {
      if (!dirent.isDirectory()) continue;
      const name = dirent.name;
      const tagPath = path.join(libPath, name);
      let tags;
      try {
        tags = await fs.readdir(tagPath, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const t of tags) {
        if (!t.isDirectory()) continue;
        const tag = t.name;
        const fullName = tag ? `${name}:${tag}` : name;
        const sizeMatch = tag && tag.match(/^(\d+(?:\.\d+)?)\s*b$/i);
        const size = sizeMatch ? sizeMatch[1] + 'B' : (tag || '—');
        list.push({ name: fullName, tag, size });
      }
    }
  } catch (err) {
    return { models: [], error: err.message || 'Path not found' };
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { models: list, error: null };
}

ipcMain.handle('get-ollama-models', async () => {
  const installed = await getInstalledOllamaModels();
  const byName = new Map(installed.models.map(m => [m.name, m]));
  try {
    const base = normalizeOllamaUrl(config.ollamaUrl || 'http://localhost:11434');
    const u = new URL(base + '/api/tags');
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const data = await new Promise((resolve, reject) => {
      const opts = { hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname, method: 'GET' };
      const req = lib.request(opts, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { resolve({}); } });
      });
      req.on('error', () => resolve({}));
      req.setTimeout(5000, () => { req.destroy(); resolve({}); });
      req.end();
    });
    const apiModels = (data.models || []).map(m => m.name || m.model || '').filter(Boolean);
    apiModels.forEach(n => {
      if (!byName.has(n)) byName.set(n, { name: n, tag: n.includes(':') ? n.split(':')[1] : '', size: '—' });
    });
  } catch (_) {}
  const models = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  return { models, error: installed.models.length === 0 ? (installed.error || null) : null };
});

ipcMain.handle('test-ollama', async () => {
  const base = normalizeOllamaUrl(config.ollamaUrl || 'http://localhost:11434');
  const u = new URL(base + '/api/tags');
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : http;
  return new Promise((resolve) => {
    const opts = { hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname, method: 'GET' };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, url: base });
        } else {
          resolve({ ok: false, error: res.statusCode + ' ' + (Buffer.concat(chunks).toString('utf8').slice(0, 80)), url: base });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message || err.code || 'Connection failed', url: base }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, error: 'Timeout', url: base }); });
    req.end();
  });
});

/** Ask Ollama to load the model (one minimal request) using Node http/https so it works in Electron main. */
function ollamaLoadModel(modelName) {
  const baseUrl = normalizeOllamaUrl(config.ollamaUrl || 'http://localhost:11434');
  const u = new URL(baseUrl + '/api/generate');
  const body = JSON.stringify({
    model: modelName,
    prompt: '.',
    stream: false,
    options: { num_predict: 1 },
  });
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : http;
  const opts = {
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') },
  };
  return new Promise((resolve) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ loaded: true });
        else resolve({ loaded: false, error: res.statusCode + ' ' + Buffer.concat(chunks).toString('utf8').slice(0, 80) });
      });
    });
    req.on('error', (err) => resolve({ loaded: false, error: err.message || 'Ollama unreachable' }));
    req.setTimeout(120000, () => { req.destroy(); resolve({ loaded: false, error: 'Timeout' }); });
    req.write(body);
    req.end();
  });
}

ipcMain.handle('set-model', async (_, modelName) => {
  if (!modelName || typeof modelName !== 'string') return { ok: false, loaded: false };
  const name = modelName.trim();
  config.ollamaModel = name;
  if (thinking && thinking.setModel) thinking.setModel(name);
  configSaveScheduled = true;
  setImmediate(() => flushConfigSave());
  if (!config.useLlamaCpp && !config.openaiBaseUrl) {
    const loadResult = await ollamaLoadModel(name);
    return { ok: true, model: name, loaded: loadResult.loaded, error: loadResult.error };
  }
  return { ok: true, model: name, loaded: true };
});
ipcMain.handle('get-models-path', () => MODELS_PATH);
ipcMain.handle('get-memory-stats', async () => memory.getStats());
ipcMain.handle('get-metrics', () => (metrics ? metrics.getMetrics() : null));
ipcMain.handle('get-current-activity', () => (metrics ? metrics.getCurrentActivity() : null));
ipcMain.handle('get-hormones', () => (memory.getState().hormones || { dopamine: 0.5, cortisol: 0.2, serotonin: 0.5 }));
ipcMain.handle('get-living-state', async () => {
  const state = memory.getState();
  const stats = memory.getStats();
  const loop = mindLoop
    ? { running: true, paused: mindLoop.paused, nextIntervalMs: mindLoop.intervalMs, lastTickTime: mindLoop._lastTickTime || 0 }
    : { running: false, paused: true, nextIntervalMs: 0, lastTickTime: 0 };
  return {
    hormones: state.hormones || { dopamine: 0.5, cortisol: 0.2, serotonin: 0.5 },
    emotions: state.emotions || { joy: 0.3, frustration: 0.1, interest: 0.5, confusion: 0.2 },
    stats: { neurons: stats.neurons, synapses: stats.synapses, thoughts: stats.thoughts, episodes: stats.episodes, goals: stats.goals },
    living: { lastTickTime: loop.lastTickTime, nextIntervalMs: loop.nextIntervalMs },
    loopStatus: { running: loop.running, paused: loop.paused },
  };
});
ipcMain.handle('get-thoughts', async () => memory.getRecentThoughts(50));
ipcMain.handle('get-logs', async () => memory.getRecentLogs(100));
ipcMain.handle('get-chat-history', async () => memory.getChatHistory(50));
ipcMain.handle('get-inner-thoughts', async () => memory.getRecentInnerThoughts(30));
ipcMain.handle('get-goals', async () => memory.getGoals(false));
ipcMain.handle('set-goal', async (_, text) => {
  if (!text || typeof text !== 'string') return null;
  return memory.addGoal(text.trim().slice(0, 300));
});
ipcMain.handle('human-feedback', async (_, payload) => {
  if (!memory) return;
  const rating = payload && (payload.rating != null ? payload.rating : payload.thumbs);
  const comment = payload && (typeof payload.comment === 'string' ? payload.comment : '');
  memory.addHumanFeedback(rating, comment);
});
ipcMain.handle('complete-goal', async (_, id) => {
  if (id && typeof id === 'string' && id.length <= 64) memory.completeGoal(id);
});
ipcMain.handle('send-chat', async (_, text) => {
  if (!text || typeof text !== 'string') return { reply: '', error: 'Empty message' };
  let userMessage = text.trim().slice(0, 4000);
  if (userMessage.toLowerCase().startsWith('goal:')) {
    const goalText = userMessage.slice(5).trim();
    if (goalText) memory.addGoal(goalText);
    userMessage = 'User set a goal: ' + goalText;
  } else if (/^(can you|please|could you|would you|do |add |make |fix |improve |work on |i need you to|run |test )/i.test(userMessage)) {
    const goalText = userMessage.slice(0, 300);
    memory.addGoal(goalText);
    memory.setCurrentTask(goalText);
  }
  memory.addChatMessage('user', userMessage);
  let reply = '';
  let fromModel = false;
  let innerThought = null;
  try {
    const out = await thinking.chat(userMessage);
    if (out && typeof out === 'object' && 'reply' in out) {
      reply = out.reply || '';
      fromModel = out.fromModel === true;
      if (out.innerThought && typeof out.innerThought === 'string') innerThought = out.innerThought.trim();
    } else {
      reply = typeof out === 'string' ? out : "I couldn't form a reply right now.";
      fromModel = false;
    }
  } catch (e) {
    reply = "Could not reach the model: " + (e.message || 'error');
    console.error('[send-chat]', e.message || e);
  }
  if (fromModel) {
    memory.addChatMessage('assistant', reply);
    await memory.save();
    if (config.speakThoughts) action.speak(reply.slice(0, 200));
  }
  return { reply, fromModel, innerThought: innerThought || undefined };
});
ipcMain.handle('think-once', async () => mindLoop.tick());
ipcMain.handle('pause-loop', () => mindLoop.pause());
ipcMain.handle('resume-loop', () => mindLoop.resume());
ipcMain.handle('speak', async (_, text) => action.speak(text));
ipcMain.handle('browse', async (_, url) => action.openUrl(url));
ipcMain.handle('read-file', async (_, filePath) => perception.readFile(filePath));
ipcMain.handle('list-dir', async (_, dirPath) => perception.listDir(dirPath));
ipcMain.handle('write-file', async (_, filePath, content) => action.writeFile(filePath, content));
ipcMain.handle('fetch-url', async (_, url, options) => perception.fetchUrl(url, options));
ipcMain.handle('choose-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (canceled || !filePaths.length) return null;
  const dir = path.resolve(filePaths[0]);
  const allowed = dedupeAllowedDirs(config.allowedDirs);
  if (!allowed.some(d => path.resolve(d) === dir)) {
    config.allowedDirs = [...allowed, dir];
    config.workspacePath = config.workspacePath || dir;
    if (perception) perception.allowedDirs = config.allowedDirs;
    if (action) action.allowedDirs = config.allowedDirs;
    if (curiosity) curiosity.allowedDirs = config.allowedDirs;
    configSaveScheduled = true;
    await flushConfigSave();
  }
  return dir;
});
ipcMain.handle('add-allowed-dir', async (_, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string') return { ok: false };
  const dir = path.resolve(dirPath.trim());
  const allowed = dedupeAllowedDirs(config.allowedDirs);
  if (allowed.some(d => path.resolve(d) === dir)) return { ok: true, already: true };
  config.allowedDirs = [...allowed, dir];
  config.workspacePath = config.workspacePath || dir;
  if (perception) perception.allowedDirs = config.allowedDirs;
  if (action) action.allowedDirs = config.allowedDirs;
  if (curiosity) curiosity.allowedDirs = config.allowedDirs;
  configSaveScheduled = true;
  await flushConfigSave();
  return { ok: true };
});
ipcMain.handle('add-allowed-host', async (_, host) => {
  if (!host || typeof host !== 'string') return { ok: false };
  const h = host.trim().toLowerCase();
  if (!config.allowedHosts) config.allowedHosts = ['*'];
  if (config.allowedHosts.includes('*') || config.allowedHosts.includes(h)) return { ok: true, already: true };
  config.allowedHosts = [...config.allowedHosts, h];
  configSaveScheduled = true;
  await flushConfigSave();
  return { ok: true };
});
ipcMain.handle('save-config', async (_, newConfig) => {
  const safe = { ...newConfig };
  delete safe.openaiApiKey;
  Object.assign(config, safe);
  if (safe.allowedDirs) config.allowedDirs = dedupeAllowedDirs(config.allowedDirs);
  configSaveScheduled = true;
  await flushConfigSave();
  const out = { ...config };
  if (out.openaiApiKey) out.openaiApiKey = '(hidden)';
  return out;
});
