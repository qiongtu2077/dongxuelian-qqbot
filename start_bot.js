const { App } = require('koishi')

async function main() {
  console.log('[START] Creating app...')
  const app = new App()

  // Register server plugin
  app.plugin(require('@koishijs/plugin-server'), {
    port: 5140,
    selfUrl: 'http://localhost:5140',
  })

  await app.start()
  console.log('[OK] App started')

  // Manually create and register the bot
  const { OneBotBot } = require('@satorijs/adapter-onebot')

  const bot = new OneBotBot(app, {
    protocol: 'ws',
    selfId: '3651312852',
    endpoint: 'ws://127.0.0.1:8080/onebot/v11/ws',
  })

  app.bots.push(bot)
  console.log('[OK] Bot registered:', bot.sid)

  // Wait for connection
  await new Promise(resolve => setTimeout(resolve, 5000))
  console.log('[STATUS] Bot status:', bot.status)
  console.log('[STATUS] Bot online:', bot.isOnline)
  console.log('[DONE]')
  process.exit(0)
}

main().catch(err => {
  console.error('[FAIL]', err)
  process.exit(1)
})
