const fs = require('fs').promises;
const path = require('path');
const { shell } = require('electron');
const { isAllowedPath, isAllowedHost, isAllowedUrlProtocol } = require('./allow');

const MAX_WRITE_BYTES = 5 * 1024 * 1024;

let fetchImpl;
try { fetchImpl = require('node-fetch'); } catch (_) { fetchImpl = globalThis.fetch; }

class Action {
  constructor(config, sendToRenderer) {
    this.config = config;
    this.sendToRenderer = sendToRenderer;
    this.allowedDirs = config.allowedDirs || [];
    this.browserExternal = config.browserExternal !== false;
  }

  async writeFile(filePath, content) {
    const resolved = path.resolve(filePath);
    const dir = path.dirname(resolved);
    if (!isAllowedPath(resolved, this.allowedDirs)) {
      return { ok: false, error: 'Path not allowed' };
    }
    const str = typeof content === 'string' ? content : String(content);
    const byteLength = Buffer.byteLength(str, 'utf8');
    if (byteLength > MAX_WRITE_BYTES) {
      return { ok: false, error: 'Content too large (max 5MB)' };
    }
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(resolved, str, 'utf8');
      this.sendToRenderer('log', { type: 'write', path: resolved });
      return { ok: true, path: resolved };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  openUrl(url) {
    if (!url || typeof url !== 'string') return { ok: false, error: 'Invalid URL' };
    if (!isAllowedUrlProtocol(url)) return { ok: false, error: 'Only http and https URLs are allowed' };
    const allowedHosts = this.config.allowedHosts || ['*'];
    if (!isAllowedHost(url, allowedHosts)) return { ok: false, error: 'Host not allowed' };
    try {
      if (this.browserExternal) {
        shell.openExternal(url);
      }
      this.sendToRenderer('log', { type: 'browse', url });
      return { ok: true, url };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  speak(text) {
    if (!text || !this.sendToRenderer) return;
    this.sendToRenderer('speak-request', String(text).slice(0, 2000));
  }

  async httpRequest(url, options = {}) {
    if (!fetchImpl) return { ok: false, error: 'No fetch available' };
    const method = (options.method || 'GET').toUpperCase();
    const opt = {
      method,
      headers: { 'User-Agent': 'AutonomousLivingAI/1.0', ...(options.headers || {}) },
    };
    if (options.body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      opt.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      if (!opt.headers['Content-Type']) opt.headers['Content-Type'] = 'application/json';
    }
    try {
      const res = await fetchImpl(url, opt);
      const text = await res.text();
      this.sendToRenderer('log', { type: 'http', url, method, status: res.status });
      return { ok: res.ok, status: res.status, body: text };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

module.exports = Action;
