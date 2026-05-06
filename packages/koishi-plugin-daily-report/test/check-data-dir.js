const path = require('path');
const dailyReportConfig = require(path.join(process.cwd(), 'packages/koishi-plugin-daily-report/lib/config'));
console.log('DATA_DIR from daily-report config:', dailyReportConfig.DATA_DIR);

// Simulate what collectReportData does
const key = '917625559';
const today = new Date().toISOString().slice(0, 10);
const cacheFile = path.join(dailyReportConfig.DATA_DIR, 'today-cache-' + key + '.json');
console.log('Cache file path:', cacheFile);
console.log('File exists:', require('fs').existsSync(cacheFile));
