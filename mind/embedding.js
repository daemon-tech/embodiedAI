/**
 * Embedding service: machine learning for memory.
 * Produces vector representations of anything (thoughts, facts, episodes, learnings).
 * Used for similarity retrieval so the brain recalls by meaning, not just recency.
 * Real-time: non-blocking; failures are silent so the loop never stalls.
 */

let fetchImpl;
try { fetchImpl = require('node-fetch'); } catch (_) { fetchImpl = globalThis.fetch; }
let nodeHttp, nodeHttps;
try { nodeHttp = require('http'); nodeHttps = require('https'); } catch (_) {}

function normalizeOllamaUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
    return u.toString().replace(/\/$/, '');
  } catch (_) { return String(url).replace(/\/$/, ''); }
}

const EMBED_TIMEOUT_MS = 15000;

class Embedding {
  constructor(config) {
    this.config = config || {};
    this.ollamaUrl = normalizeOllamaUrl(this.config.ollamaUrl || 'http://localhost:11434');
    this.embeddingModel = this.config.embeddingModel || 'nomic-embed-text';
    this.openaiBaseUrl = (this.config.openaiBaseUrl || '').replace(/\/$/, '');
    this.openaiApiKey = this.config.openaiApiKey || '';
    this.useOpenAI = Boolean(this.openaiBaseUrl && this.openaiApiKey);
    this._lastErrorLog = 0;
    this._throttleMs = 60000;
  }

  /**
   * Embed one or more texts. Returns array of vectors (same order as input).
   * Returns null on failure so callers can skip retrieval/store without breaking.
   */
  async embed(textOrTexts) {
    const inputs = Array.isArray(textOrTexts) ? textOrTexts : [textOrTexts];
    const trimmed = inputs.map(t => String(t || '').trim().slice(0, 8000)).filter(Boolean);
    if (trimmed.length === 0) return Array.isArray(textOrTexts) ? [] : null;

    if (this.useOpenAI) return this._embedOpenAI(trimmed, !Array.isArray(textOrTexts));
    return this._embedOllama(trimmed, !Array.isArray(textOrTexts));
  }

  async _embedOllama(texts, single) {
    const url = `${this.ollamaUrl}/api/embed`;
    const body = JSON.stringify({
      model: this.embeddingModel,
      input: texts.length === 1 ? texts[0] : texts,
    });

    const doRequest = () => {
      if (nodeHttp && nodeHttps) {
        return this._embedOllamaNode(url, body, texts.length, single);
      }
      return this._embedOllamaFetch(url, body, texts.length, single);
    };

    try {
      const result = await Promise.race([
        doRequest(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('embed_timeout')), EMBED_TIMEOUT_MS)),
      ]);
      return result;
    } catch (err) {
      if (Date.now() - this._lastErrorLog > this._throttleMs) {
        this._lastErrorLog = Date.now();
        console.error('Embedding error:', err.message || err);
      }
      return single ? null : [];
    }
  }

  async _embedOllamaNode(url, body, expectedCount, single) {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? nodeHttps : nodeHttp;
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') },
      };
      const req = lib.request(opts, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            const data = JSON.parse(raw);
            const emb = data.embeddings;
            if (!Array.isArray(emb)) {
              resolve(single ? null : []);
              return;
            }
            if (expectedCount === 1 && emb.length >= 1) {
              resolve(single ? emb[0] : emb);
              return;
            }
            resolve(emb.slice(0, expectedCount));
          } catch (_) {
            resolve(single ? null : []);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(EMBED_TIMEOUT_MS, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });
  }

  async _embedOllamaFetch(url, body, expectedCount, single) {
    if (!fetchImpl) return single ? null : [];
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) return single ? null : [];
    const data = await res.json().catch(() => ({}));
    const emb = data.embeddings;
    if (!Array.isArray(emb) || emb.length === 0) return single ? null : [];
    if (expectedCount === 1 && emb.length >= 1) return single ? emb[0] : emb;
    return emb.slice(0, expectedCount);
  }

  async _embedOpenAI(texts, single) {
    const url = `${this.openaiBaseUrl}/v1/embeddings`;
    const body = JSON.stringify({
      model: this.config.openaiEmbeddingModel || 'text-embedding-3-small',
      input: texts.length === 1 ? texts[0] : texts,
    });
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.openaiApiKey}`,
        },
        body,
      });
      if (!res.ok) return single ? null : [];
      const data = await res.json().catch(() => ({}));
      const list = data.data;
      if (!Array.isArray(list)) return single ? null : [];
      const vectors = list.map((d) => d.embedding).filter(Boolean);
      if (single && vectors.length >= 1) return vectors[0];
      return vectors;
    } catch (err) {
      if (Date.now() - this._lastErrorLog > this._throttleMs) {
        this._lastErrorLog = Date.now();
        console.error('OpenAI embedding error:', err.message);
      }
      return single ? null : [];
    }
  }
}

module.exports = Embedding;
