const path = require('path');
const { URL } = require('url');

/**
 * Shared safety checks for paths and URLs. Used by Perception, Action, and MindLoop.
 */
function isAllowedPath(filePath, allowedDirs) {
  if (!filePath || typeof filePath !== 'string' || !Array.isArray(allowedDirs) || allowedDirs.length === 0) return false;
  const normalized = path.resolve(filePath);
  return allowedDirs.some(dir => {
    const d = path.resolve(dir);
    return normalized === d || normalized.startsWith(d + path.sep);
  });
}

function isAllowedHost(urlStr, allowedHosts) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  if (allowedHosts && allowedHosts.includes('*')) return true;
  try {
    const host = new URL(urlStr).hostname;
    return Array.isArray(allowedHosts) && allowedHosts.some(h => h === host || host.endsWith('.' + h));
  } catch (_) {
    return false;
  }
}

/** Only http/https; use with isAllowedHost for fetch/open. */
function isAllowedUrlProtocol(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const p = new URL(urlStr).protocol;
    return p === 'http:' || p === 'https:';
  } catch (_) {
    return false;
  }
}

/** Allowed terminal commands: must start with configured prefixes (or defaults). Block dangerous patterns. */
const DEFAULT_CMD_PREFIXES = ['npm ', 'npx ', 'node ', 'node.exe ', 'dir ', 'ls ', 'git '];
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//, /\brm\s+-rf\s+/i, /\brm\s+-\*\s+/i, /\brm\s+.*\/\s*$/,
  /\bsudo\b/i, /\bsu\s+-\s*$/,
  />\s*\/etc\//, /\|\s*sh\s*$/, /\|\s*bash\s*$/i,
  /\bdd\s+if=.*of=\/dev\//i, /\bdd\s+of=\/dev\/sd/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,  // fork bomb
  /\bmkfs\./i, /\bformat\s+/i,
  /chmod\s+-R\s+777\s+\//i, /chown\s+-R\s+.*\s+\//i,
  />\s*\/\s*$/, /\|\s*tee\s+\/etc\//i,
  /\bwget\s+.*\|\s*sh\s*$/i, /\bcurl\s+.*\|\s*(?:bash|sh)\s*$/i,
];
function isAllowedCommand(cmdStr, config) {
  if (!cmdStr || typeof cmdStr !== 'string') return false;
  const c = cmdStr.trim();
  if (c.length > 500) return false;
  if (BLOCKED_PATTERNS.some(p => p.test(c))) return false;
  const prefixes = Array.isArray(config?.allowedCommandPrefixes) && config.allowedCommandPrefixes.length > 0
    ? config.allowedCommandPrefixes.map(p => (p.endsWith(' ') ? p : p + ' '))
    : DEFAULT_CMD_PREFIXES;
  return prefixes.some(prefix => c.toLowerCase().startsWith(prefix.toLowerCase().trimEnd()));
}

/** True if command is complex or potentially risky (e.g. multiple pipes, long, or contains shell metachars). */
function isRiskyCommand(cmdStr) {
  if (!cmdStr || typeof cmdStr !== 'string') return false;
  const c = cmdStr.trim();
  if (c.length > 200) return true;
  if ((c.match(/\|/g) || []).length >= 2) return true;
  if (/[;&]/.test(c)) return true;
  return false;
}

/** True if path is mind/agent_extensions.js (risky to edit without approval). */
function isAgentExtensionsPath(filePath, appPath) {
  if (!filePath || !appPath) return false;
  const extPath = path.resolve(appPath, 'mind', 'agent_extensions.js');
  return path.resolve(filePath) === extPath;
}

module.exports = { isAllowedPath, isAllowedHost, isAllowedUrlProtocol, isAllowedCommand, isRiskyCommand, isAgentExtensionsPath };
