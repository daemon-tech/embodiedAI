const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const Memory = require('../mind/memory');

async function run() {
  const tmpDir = path.join(os.tmpdir(), 'embodied-ai-test-' + Date.now());
  await fs.mkdir(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, 'memory.json');

  const memory = new Memory(filePath);
  await memory.load();

  const state = memory.getState();
  if (!state || typeof state !== 'object') throw new Error('getState returns object');

  memory.addThought('hello', { action: 'think' });
  const thoughts = memory.getRecentThoughts(5);
  if (thoughts.length < 1 || thoughts[0].text !== 'hello') throw new Error('addThought / getRecentThoughts');

  memory.setState({ totalReads: 42 });
  if (memory.getState().totalReads !== 42) throw new Error('setState');

  const stats = memory.getStats();
  if (stats.thoughts < 1) throw new Error('getStats.thoughts');

  await memory.save();
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.thoughts || parsed.thoughts.length < 1) throw new Error('persisted thoughts');

  const auditPath = path.join(tmpDir, 'audit_log.json');
  const memWithAudit = new Memory(filePath, null, null, auditPath);
  await memWithAudit.addAuditLog({ type: 'test', args: {}, outcome: 'ok' });
  const auditRaw = await fs.readFile(auditPath, 'utf8');
  const auditList = JSON.parse(auditRaw);
  if (auditList.length !== 1 || auditList[0].type !== 'test') throw new Error('audit log');

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log('memory.test.js: all passed');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});