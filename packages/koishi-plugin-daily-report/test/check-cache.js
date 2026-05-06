const fs = require('fs');
const path = require('path');

const channelKey = process.argv[2] || '917625559';
const dataDir = process.env.DONGXUELIAN_AI_DATA_DIR || '/root/koishi-app/data';
const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_');
const cacheFile = path.join(dataDir, 'today-cache-' + safeKey + '.json');
console.log('File:', cacheFile);
console.log('Exists:', fs.existsSync(cacheFile));

if (fs.existsSync(cacheFile)) {
  const raw = fs.readFileSync(cacheFile, 'utf8');
  const cache = JSON.parse(raw);
  console.log('Date:', cache.date);
  console.log('Today:', new Date().toISOString().slice(0, 10));
  console.log('Match:', cache.date === new Date().toISOString().slice(0, 10));
  console.log('Messages:', cache.messages ? cache.messages.length : 0);
}
