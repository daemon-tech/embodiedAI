const path = require('path');
const { isAllowedPath, isAllowedHost, isAllowedUrlProtocol } = require('../mind/allow');

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

console.log('allow.test.js: all passed');