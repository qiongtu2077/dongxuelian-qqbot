const { App } = require('koishi')
const { OneBotBot } = require('@satorijs/adapter-onebot')

const app = new App({
  port: 5141,
})

app.plugin(require('@koishijs/plugin-server'), {
  port: 5141,
  selfUrl: 'http://localhost:5141',
})

app.plugin(require('koishi-plugin-adapter-onebot'), {
  protocol: 'ws',
  selfId: '3651312852',
  endpoint: 'ws://127.0.0.1:8080/onebot/v11/ws',
})

app.start().then(() => {
  console.log('App started')
  setTimeout(() => {
    console.log('Bots:', app.bots.map(b => b.sid + '=' + b.status))
    process.exit(0)
  }, 5000)
}).catch(err => {
  console.error('Start error:', err)
  process.exit(1)
})
