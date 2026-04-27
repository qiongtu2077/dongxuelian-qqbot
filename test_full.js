const { App } = require('koishi')
const { OneBotBot } = require('@satorijs/adapter-onebot')

async function main() {
  const app = new App({ port: 5140 })
  await app.start()
  console.log('[OK] App started')
  
  const bot = new OneBotBot(app, {
    protocol: 'ws',
    selfId: '3651312852',
    endpoint: 'ws://127.0.0.1:8080/onebot/v11/ws',
  })
  app.bots.push(bot)
  console.log('[OK] Bot registered:', bot.sid)
  
  // Let the connection establish
  await new Promise(resolve => setTimeout(resolve, 5000))
  
  console.log('[OK] Bot status:', bot.status)
  console.log('[OK] Bot online:', bot.isOnline)
  
  // Try login
  try {
    const login = await bot.getLogin()
    console.log('[OK] Login:', JSON.stringify(login))
  } catch(e) {
    console.log('[WARN] getLogin failed:', e.message)
  }
  
  process.exit(0)
}
main().catch(err => { console.error('[FAIL]', err.message); process.exit(1) })
