/**
 * Start llama.cpp server on app startup: download server binary + Qwen3-8B Q4 GGUF if needed, spawn server, wait until ready.
 * Uses OpenAI-compatible API so the app talks to it via openaiBaseUrl.
 */
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const LLAMA_RELEASE = 'b7951';
const LLAMA_RELEASE_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}`;
const QWEN3_GGUF_URL = 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf';
const QWEN3_GGUF_FILENAME = 'Qwen3-8B-Q4_K_M.gguf';
const DEFAULT_PORT = 11435;

function getPlatformAsset() {
  const p = process.platform;
  const a = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x64';
  if (p === 'win32') return { url: `${LLAMA_RELEASE_URL}/llama-${LLAMA_RELEASE}-bin-win-cpu-${a}.zip`, ext: 'zip' };
  if (p === 'darwin') return { url: `${LLAMA_RELEASE_URL}/llama-${LLAMA_RELEASE}-bin-macos-${a}.tar.gz`, ext: 'tar.gz' };
  if (p === 'linux') return { url: `${LLAMA_RELEASE_URL}/llama-${LLAMA_RELEASE}-bin-ubuntu-x64.tar.gz`, ext: 'tar.gz' };
  return null;
}

function getServerExeName() {
  // Official build produces llama-server (tools/server); older builds used "server"
  return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

async function downloadFile(url, destPath, onProgress) {
  const proto = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const file = fsSync.createWriteStream(destPath, { flags: 'w' });
    const request = proto.get(url, { headers: { 'User-Agent': 'EmbodiedAI/1.0' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fsSync.unlinkSync(destPath);
        downloadFile(res.headers.location, destPath, onProgress).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fsSync.unlinkSync(destPath);
        reject(new Error(`Download failed: ${res.statusCode} ${res.statusMessage}`));
        return;
      }
      const total = parseInt(res.headers['content-length'], 10) || 0;
      let done = 0;
      res.on('data', (chunk) => {
        done += chunk.length;
        if (onProgress && total) onProgress(done, total);
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    request.on('error', (err) => {
      file.close();
      try { fsSync.unlinkSync(destPath); } catch (_) {}
      reject(err);
    });
  });
}

async function extractZip(zipPath, outDir) {
  const extractZip = require('extract-zip');
  await fs.mkdir(outDir, { recursive: true });
  await extractZip(zipPath, { dir: path.resolve(outDir) });
}

async function extractTarGz(tarPath, outDir) {
  const tar = require('tar');
  await fs.mkdir(outDir, { recursive: true });
  await tar.extract({ file: tarPath, cwd: outDir });
}

function findServerInDir(dir) {
  // Official releases: llama-server[.exe]; some older builds: server[.exe]
  const names = process.platform === 'win32'
    ? ['llama-server.exe', 'server.exe', 'llama-server', 'server']
    : ['llama-server', 'server'];
  for (const name of names) {
    const p = path.join(dir, name);
    if (fsSync.existsSync(p)) return p;
  }
  const entries = fsSync.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findServerInDir(path.join(dir, e.name));
      if (found) return found;
    }
    const lower = e.name.toLowerCase();
    if (lower === 'llama-server.exe' || lower === 'llama-server' || lower === 'server.exe' || lower === 'server') {
      return path.join(dir, e.name);
    }
  }
  return null;
}

async function ensureLlamaServer(userDataPath) {
  const baseDir = path.join(userDataPath, 'llama-cpp');
  const binDir = path.join(baseDir, 'bin');
  const serverExe = path.join(binDir, getServerExeName());
  if (fsSync.existsSync(serverExe)) return serverExe;

  const asset = getPlatformAsset();
  if (!asset) throw new Error('Unsupported platform for llama.cpp');

  const archivePath = path.join(baseDir, `llama.${asset.ext}`);
  await fs.mkdir(path.dirname(archivePath), { recursive: true });

  console.log('Downloading llama.cpp server...');
  await downloadFile(asset.url, archivePath, (done, total) => {
    if (total && done % (5 * 1024 * 1024) < 1024 * 1024) {
      console.log(`  ${(100 * done / total).toFixed(0)}%`);
    }
  });

  const extractDir = path.join(baseDir, 'extract');
  await fs.mkdir(extractDir, { recursive: true });
  if (asset.ext === 'zip') await extractZip(archivePath, extractDir);
  else await extractTarGz(archivePath, extractDir);

  const found = findServerInDir(extractDir);
  if (!found) {
    function listDirRecursive(d, prefix = '') {
      const entries = fsSync.readdirSync(d, { withFileTypes: true });
      return entries.map(e => e.isDirectory() ? listDirRecursive(path.join(d, e.name), prefix + e.name + '/') : prefix + e.name).flat();
    }
    const listing = listDirRecursive(extractDir).join(', ');
    throw new Error('Could not find server executable in llama.cpp archive. Extracted contents: ' + (listing || '(empty)'));
  }
  await fs.mkdir(binDir, { recursive: true });
  await fs.copyFile(found, serverExe);
  await fs.unlink(archivePath).catch(() => {});
  try {
    await fs.rm(extractDir, { recursive: true }).catch(() => {});
  } catch (_) {}
  console.log('llama.cpp server ready at', serverExe);
  return serverExe;
}

async function ensureModel(userDataPath, modelPathFromConfig) {
  if (modelPathFromConfig && fsSync.existsSync(modelPathFromConfig)) return modelPathFromConfig;
  const modelsDir = path.join(userDataPath, 'llama-cpp', 'models');
  const defaultPath = path.join(modelsDir, QWEN3_GGUF_FILENAME);
  if (fsSync.existsSync(defaultPath)) return defaultPath;

  await fs.mkdir(modelsDir, { recursive: true });
  console.log('Downloading Qwen3-8B (Q4_K_M) GGUF (~5GB). This may take a few minutes...');
  await downloadFile(QWEN3_GGUF_URL, defaultPath, (done, total) => {
    if (total && done % (50 * 1024 * 1024) < 1024 * 1024) {
      console.log(`  ${(100 * done / total).toFixed(0)}%`);
    }
  });
  console.log('Model ready at', defaultPath);
  return defaultPath;
}

function waitForServer(baseUrl, maxWaitMs) {
  const url = `${baseUrl}/v1/models`;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const proto = baseUrl.startsWith('https') ? https : http;
      const req = proto.get(url, (res) => {
        if (res.statusCode === 200) return resolve();
        if (Date.now() - start > maxWaitMs) return reject(new Error('llama.cpp server did not become ready in time'));
        setTimeout(tryOnce, 800);
      });
      req.on('error', () => {
        if (Date.now() - start > maxWaitMs) return reject(new Error('llama.cpp server did not become ready in time'));
        setTimeout(tryOnce, 800);
      });
      req.setTimeout(3000, () => { req.destroy(); });
    };
    tryOnce();
  });
}

let serverProcess = null;

async function start(options = {}) {
  const userDataPath = options.userDataPath;
  if (!userDataPath) throw new Error('llama-cpp start() requires options.userDataPath');
  const port = options.port ?? DEFAULT_PORT;
  const modelPathConfig = options.modelPath || null;

  const serverPath = await ensureLlamaServer(userDataPath);
  const modelPath = await ensureModel(userDataPath, modelPathConfig);

  const args = ['-m', modelPath, '--port', String(port), '--host', '127.0.0.1'];
  if (options.ctxSize) args.push('--ctx-size', String(options.ctxSize));

  serverProcess = spawn(serverPath, args, {
    cwd: path.dirname(serverPath),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  serverProcess.stdout.on('data', (d) => { process.stdout.write(d); });
  serverProcess.stderr.on('data', (d) => { process.stderr.write(d); });
  serverProcess.on('error', (err) => console.error('llama.cpp server error:', err));
  serverProcess.on('exit', (code, sig) => {
    if (code != null && code !== 0) console.error('llama.cpp server exited:', code, sig);
    serverProcess = null;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('Waiting for llama.cpp server to load model...');
  await waitForServer(baseUrl, 120000);
  console.log('llama.cpp server ready at', baseUrl);
  return { baseUrl, port };
}

function stop() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

module.exports = { start, stop, DEFAULT_PORT };
