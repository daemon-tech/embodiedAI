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

/** Allowed terminal commands: must start with configured prefixes (or defaults). No rm -rf /, no sudo. */
const DEFAULT_CMD_PREFIXES = ['npm ', 'npx ', 'node ', 'node.exe ', 'dir ', 'ls ', 'git '];
const BLOCKED_PATTERNS = [/rm\s+-rf\s+\//, /sudo\s/, />\s*\/etc\//, /\|\s*sh\s*$/];
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

module.exports = { isAllowedPath, isAllowedHost, isAllowedUrlProtocol, isAllowedCommand };
