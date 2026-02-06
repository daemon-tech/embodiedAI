/**
 * Loop tests: mock dependencies, dry-run tick.
 */
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const Memory = require('../mind/memory');
const MindLoop = require('../mind/loop');

async function run() {
  const tmpDir = path.join(os.tmpdir(), 'embodied-loop-test-' + Date.now());
  await fs.mkdir(tmpDir, { recursive: true });
  const memoryPath = path.join(tmpDir, 'memory.json');
  const memory = new Memory(memoryPath);
  await memory.load();

  const sendToRenderer = () => {};
  const config = {
    allowedDirs: [tmpDir],
    allowedHosts: ['*'],
    appPath: path.resolve(__dirname, '..'),
    thinkIntervalMs: 6000,
    minIntervalMs: 2000,
    maxIntervalMs: 30000,
    focusMode: false,
    useJudge: false,
    runawaySameActionThreshold: 6,
    runawayConsecutiveErrors: 3,
    dryRun: true,
    archiveEveryTicks: 100,
  };

  const perception = {
    readFile: async () => ({ ok: true, content: 'mock' }),
    listDir: async () => ({ ok: true, items: [], path: tmpDir }),
    fetchUrl: async () => ({ ok: true }),
  };
  const action = {
    writeFile: async () => ({ ok: true }),
    openUrl: () => ({ ok: true }),
    speak: () => {},
  };
  const thinking = {
    decideAction: async () => ({
      type: 'read_file',
      path: path.join(tmpDir, 'x.txt'),
      nextIntervalMs: 5000,
      reason: 'Test',
    }),
    fallbackAction: () => ({ type: 'think', nextIntervalMs: 5000, reason: 'Fallback' }),
    reflect: async () => 'Reflected.',
    learnFromAction: async () => [],
    innerReflect: async () => null,
    replan: async () => {},
    metaReview: async () => {},
  };
  const curiosity = { getSuggestions: async () => ({}) };

  const loop = new MindLoop({
    memory,
    perception,
    action,
    thinking,
    curiosity,
    config,
    sendToRenderer,
    embedding: null,
    metrics: null,
  });

  await loop.tick();
  loop.stop();
  const thoughts = memory.getRecentThoughts(3);
  if (thoughts.length < 1) throw new Error('tick should add thought');
  const hasDryRun = thoughts.some(t => (t.text || '').includes('Dry run') || (t.text || '').includes('Reflected'));
  if (!hasDryRun && !thoughts[0].text) throw new Error('expected thought or dry run message');

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log('loop.test.js: all passed');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
