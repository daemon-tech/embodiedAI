const path = require('path');
const { isAllowedPath, isAllowedHost, isAllowedUrlProtocol, isAllowedCommand, isRiskyCommand, isAgentExtensionsPath } = require('../mind/allow');

const assert = (ok, msg) => {
  if (!ok) throw new Error(msg || 'assertion failed');
};

const dir = path.resolve(__dirname, '..');
const sub = path.join(dir, 'mind', 'allow.js');

assert(isAllowedPath(dir, [dir]) === true, 'same dir allowed');
assert(isAllowedPath(sub, [dir]) === true, 'subpath allowed');
assert(isAllowedPath(sub, [path.join(dir, 'mind')]) === true, 'parent dir allowed');
assert(isAllowedPath('/other/path', [dir]) === false, 'other path not allowed');
assert(isAllowedPath(null, [dir]) === false, 'null path');
assert(isAllowedPath('', [dir]) === false, 'empty path');
assert(isAllowedPath(dir, []) === false, 'empty allowedDirs');

assert(isAllowedHost('https://example.com/page', ['*']) === true, 'wildcard allows any');
assert(isAllowedHost('https://example.com', ['example.com']) === true, 'exact host');
assert(isAllowedHost('https://sub.example.com', ['example.com']) === true, 'subdomain');
assert(isAllowedHost('https://evil.com', ['example.com']) === false, 'different host');
assert(isAllowedHost('not-a-url', []) === false, 'invalid url');
assert(isAllowedHost(null, ['*']) === false, 'null url');

assert(isAllowedUrlProtocol('https://example.com') === true, 'https allowed');
assert(isAllowedUrlProtocol('http://localhost:8080') === true, 'http allowed');
assert(isAllowedUrlProtocol('file:///etc/passwd') === false, 'file not allowed');
assert(isAllowedUrlProtocol('ftp://files.example.com') === false, 'ftp not allowed');
assert(isAllowedUrlProtocol('javascript:alert(1)') === false, 'javascript not allowed');
assert(isAllowedUrlProtocol('not-a-url') === false, 'invalid url');
assert(isAllowedUrlProtocol(null) === false, 'null url');

const config = { allowedCommandPrefixes: ['npm ', 'npx ', 'node '] };
assert(isAllowedCommand('npm test', config) === true, 'npm allowed');
assert(isAllowedCommand('npx jest', config) === true, 'npx allowed');
assert(isAllowedCommand('rm -rf /', config) === false, 'rm -rf / blocked');
assert(isAllowedCommand('sudo apt update', config) === false, 'sudo blocked');
assert(isAllowedCommand('dd if=/dev/zero of=/dev/sda', config) === false, 'dd blocked');
assert(isAllowedCommand('curl x | sh', config) === false, 'pipe sh blocked');
assert(isAllowedCommand('foo', config) === false, 'unknown prefix');

assert(isRiskyCommand('npm test') === false, 'simple not risky');
assert(isRiskyCommand('a'.repeat(250)) === true, 'long command risky');
assert(isRiskyCommand('npm run a | b | c') === true, 'multiple pipes risky');

const appPath = path.resolve(__dirname, '..');
const extPath = path.join(appPath, 'mind', 'agent_extensions.js');
assert(isAgentExtensionsPath(extPath, appPath) === true, 'agent_extensions path');
assert(isAgentExtensionsPath(path.join(appPath, 'main.js'), appPath) === false, 'main.js not extensions');

console.log('allow.test.js: all passed');