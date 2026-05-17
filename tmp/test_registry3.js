const path = require('path')
const AI_LIB = '/root/koishi-app/packages/koishi-plugin-dongxuelian-ai/lib'
const r = require(path.join(AI_LIB, 'agent', 'tools', 'registry'))
console.log('typeof getToolSummaries:', typeof r.getToolSummaries)
console.log('keys:', Object.keys(r).join(', '))
