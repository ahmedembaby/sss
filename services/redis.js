const Redis = require('ioredis');
const { REDIS_URL } = require('../config');

let client = null;
if (REDIS_URL) {
  client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
  let lastLog = 0;
  client.on('error', (err) => {
    if (Date.now() - lastLog > 30000) {
      lastLog = Date.now();
      console.warn('⚠️  Redis unavailable:', err.message, '(falling back to in-memory)');
    }
  });
}

const isReady = () => !!client && client.status === 'ready';

module.exports = { client, isReady };
