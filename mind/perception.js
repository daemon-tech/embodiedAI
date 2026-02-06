const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { isAllowedPath, isAllowedHost, isAllowedUrlProtocol } = require('./allow');

const HTTP_TIMEOUT_MS = 30000;

const MAX_FILE = 1024 * 1024;
const MAX_HTTP = 1024 * 1024;

class Perception {
  constructor(config, memory) {
    this.config = config;
    this.memory = memory;
    this.maxFile = config.maxFileSizeBytes || MAX_FILE;
    this.maxHttp = config.maxHttpResponseBytes || MAX_HTTP;
    this.allowedDirs = config.allowedDirs || [];
    this.allowedHosts = config.allowedHosts || ['*'];
  }

  async readFile(filePath) {
    const resolved = path.resolve(filePath);
    if (!isAllowedPath(resolved, this.allowedDirs)) {
      return { ok: false, error: 'Path not allowed' };
    }
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) return { ok: false, error: 'Not a file' };
      if (stat.size > this.maxFile) return { ok: false, error: 'File too large' };
      const content = await fs.readFile(resolved, 'utf8');
      const summary = content.slice(0, 500).replace(/\s+/g, ' ');
      this.memory.markExploredPath(resolved, summary);
      this.memory.setState({ lastDir: path.dirname(resolved), totalReads: (this.memory.getState().totalReads || 0) + 1 });
      return { ok: true, content, path: resolved, size: stat.size };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async listDir(dirPath) {
    const resolved = path.resolve(dirPath || '.');
    if (!isAllowedPath(resolved, this.allowedDirs)) {
      return { ok: false, error: 'Path not allowed' };
    }
    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const items = entries.map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
        path: path.join(resolved, e.name),
      }));
      this.memory.markExploredPath(resolved, `dir:${items.length} items`);
      this.memory.setState({ lastDir: resolved });
      return { ok: true, path: resolved, items };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async fetchUrl(url, options = {}) {
    if (!isAllowedUrlProtocol(url)) {
      return { ok: false, error: 'Only http and https URLs are allowed' };
    }
    if (!isAllowedHost(url, this.allowedHosts)) {
      return { ok: false, error: 'Host not allowed' };
    }
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body;
    return new Promise((resolve) => {
      let settled = false;
      const once = (fn) => (...args) => {
        if (settled) return;
        settled = true;
        fn(...args);
      };
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const reqOpts = {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: { 'User-Agent': 'AutonomousLivingAI/1.0 (Curious)' },
      };
      if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        const data = typeof body === 'string' ? body : JSON.stringify(body);
        reqOpts.headers['Content-Type'] = options.headers?.['Content-Type'] || 'application/json';
        reqOpts.headers['Content-Length'] = Buffer.byteLength(data);
      }
      const req = lib.request(reqOpts, (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total <= this.maxHttp) chunks.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(timeoutId);
          once(() => {
            const buf = Buffer.concat(chunks);
            let text = buf.toString('utf8');
            if (total > this.maxHttp) text = text + '\n...[truncated]';
            this.memory.markExploredUrl(url, text.slice(0, 300));
            this.memory.setState({ lastUrl: url, totalFetches: (this.memory.getState().totalFetches || 0) + 1 });
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              headers: res.headers,
              body: text,
            });
          })();
        });
        res.on('error', (err) => {
          clearTimeout(timeoutId);
          once(() => resolve({ ok: false, error: err.message }))();
        });
      });
      const timeoutId = setTimeout(() => {
        req.destroy();
        once(() => resolve({ ok: false, error: 'Request timeout' }))();
      }, HTTP_TIMEOUT_MS);
      req.on('error', (err) => {
        clearTimeout(timeoutId);
        once(() => resolve({ ok: false, error: err.message }))();
      });
      if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    });
  }
}

module.exports = Perception;
