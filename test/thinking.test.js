const Thinking = require('../mind/thinking');

const config = { ollamaUrl: 'http://localhost:11434', ollamaModel: 'test' };
const memory = {
  getState: () => ({ hormones: {} }),
  getRecentThoughts: () => [],
  getExploredPaths: () => ({}),
  getExploredUrls: () => ({}),
};

const thinking = new Thinking(config, memory);

const fallbackLowFatigue = thinking.fallbackAction({ fatigue: 0.2 });
if (fallbackLowFatigue.type !== 'think') throw new Error('low fatigue should return think');
if (!Number.isFinite(fallbackLowFatigue.nextIntervalMs)) throw new Error('nextIntervalMs required');
if (typeof fallbackLowFatigue.reason !== 'string') throw new Error('reason required');

const fallbackHighFatigue = thinking.fallbackAction({ dopamine: 0.2, cortisol: 0.8 });
if (fallbackHighFatigue.type !== 'think') throw new Error('fallback always returns think');

console.log('thinking.test.js: all passed');