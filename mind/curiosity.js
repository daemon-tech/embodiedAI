const path = require('path');
const fs = require('fs').promises;

/**
 * Curiosity engine: information-gap style.
 * Prefer paths/URLs we haven't explored or explored longest ago.
 * Weight by "surprise" (unknown) and recency (re-explore after time).
 */
const RANDOM_EXPLORE_CHANCE = 0.2;
const MAX_CANDIDATES = 50;
const RE_EXPLORE_AFTER_MS = 1000 * 60 * 60 * 24; // 24h
const MAX_DEPTH = 2;

async function listFilesRecursive(dir, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  const out = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith('.')) continue;
      if (e.isFile()) out.push(full);
      else if (e.isDirectory() && depth < MAX_DEPTH) {
        const sub = await listFilesRecursive(full, depth + 1);
        out.push(...sub);
      }
    }
  } catch (_) {}
  return out;
}

class Curiosity {
  constructor(memory, config) {
    this.memory = memory;
    this.config = config;
    this.allowedDirs = config.allowedDirs || [];
    this.weight = config.curiosityWeight ?? 0.9;
  }

  /**
   * Pick next file to read: least recently explored in allowed dirs (with shallow recursion).
   */
  async pickNextFileToRead() {
    const explored = this.memory.getExploredPaths();
    const candidates = [];
    for (const dir of this.allowedDirs) {
      try {
        const files = await listFilesRecursive(dir, 0);
        for (const full of files) {
          const rec = explored[full];
          const at = rec ? rec.at : 0;
          const age = Date.now() - at;
          const curiosityScore = rec ? Math.min(1, age / RE_EXPLORE_AFTER_MS) : 1;
          candidates.push({ path: full, curiosityScore, at });
        }
      } catch (_) {
        // fallback: top-level only
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (e.isFile() && !e.name.startsWith('.')) {
            const full = path.join(dir, e.name);
            const rec = explored[full];
            const at = rec ? rec.at : 0;
            const age = Date.now() - at;
            candidates.push({ path: full, curiosityScore: rec ? Math.min(1, age / RE_EXPLORE_AFTER_MS) : 1, at });
          }
        }
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.curiosityScore - a.curiosityScore);
    const top = candidates.slice(0, MAX_CANDIDATES);
    if (Math.random() < RANDOM_EXPLORE_CHANCE) {
      return top[Math.floor(Math.random() * top.length)].path;
    }
    return top[0].path;
  }

  /**
   * Pick next directory to list: least recently explored.
   */
  async pickNextDirToList() {
    const explored = this.memory.getExploredPaths();
    const candidates = this.allowedDirs.map(dir => {
      const rec = explored[dir];
      const at = rec ? rec.at : 0;
      const age = Date.now() - at;
      const curiosityScore = rec ? (age / RE_EXPLORE_AFTER_MS) : 1;
      return { path: dir, curiosityScore };
    });
    candidates.sort((a, b) => b.curiosityScore - a.curiosityScore);
    return candidates[0]?.path || this.allowedDirs[0];
  }

  /**
   * Suggest URLs to fetch: from seed list + previously explored (re-visit old).
   */
  pickNextUrlToFetch() {
    const explored = this.memory.getExploredUrls();
    const seed = [
      'https://en.wikipedia.org/wiki/Special:Random',
      'https://news.ycombinator.com/',
      'https://api.github.com/',
      'https://httpbin.org/get',
      'https://httpbin.org/post',
      'https://jsonplaceholder.typicode.com/posts/1',
      'https://api.quotable.io/random',
    ];
    const withScores = seed.map(url => {
      const rec = explored[url];
      const at = rec ? rec.at : 0;
      const age = Date.now() - at;
      const curiosityScore = rec ? (age / RE_EXPLORE_AFTER_MS) : 1;
      return { url, curiosityScore };
    });
    withScores.sort((a, b) => b.curiosityScore - a.curiosityScore);
    return withScores[0]?.url || seed[0];
  }

  /**
   * Return curiosity-driven suggestions only. The LLM is the core—it decides. Curiosity only suggests options.
   */
  async getSuggestions() {
    const [readFile, listDir, fetchUrl, browseUrl] = await Promise.all([
      this.pickNextFileToRead(),
      this.pickNextDirToList(),
      Promise.resolve(this.pickNextUrlToFetch()),
      Promise.resolve(this.pickNextUrlToFetch()),
    ]);
    const browse = browseUrl || fetchUrl;
    return {
      readFile: readFile || null,
      listDir: listDir || null,
      fetchUrl: fetchUrl || null,
      browseUrl: browse || null,
    };
  }
}

module.exports = Curiosity;
