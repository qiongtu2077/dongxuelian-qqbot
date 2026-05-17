const r = require('/root/koishi-app/packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/registry')
console.log('Keys:', Object.keys(r).join(', '))
console.log('has getToolSummaries:', typeof r.getToolSummaries === 'function')
console.log('has executeTool:', typeof r.executeTool === 'function')
