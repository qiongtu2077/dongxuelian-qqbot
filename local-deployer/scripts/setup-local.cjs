const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..', '..')
const runtime = path.join(root, 'runtime')
const data = path.join(root, 'data')

for (const dir of [runtime, path.join(runtime, 'downloads'), path.join(runtime, 'logs'), path.join(runtime, 'napcat'), data]) {
  fs.mkdirSync(dir, { recursive: true })
}

const qq = process.argv[2] || '请在 Dashboard 部署页填写机器人QQ后生成'
const yml = `port: 5140
selfUrl: http://localhost:5140
plugins:
  adapter-onebot:
    protocol: ws
    selfId: '${qq}'
    endpoint: ws://127.0.0.1:8080/onebot/v11/ws
  dongxuelian-ai: {}
  dongxuelian-help: {}
  group-name-at: {}
  defense: {}
  local-video-sender: {}
  group-leave-notice: {}
  dongxuelian-poke: {}
  daily-report: {}
`
fs.writeFileSync(path.join(root, 'koishi.yml'), yml, 'utf8')
fs.writeFileSync(path.join(root, 'start-local.bat'), '@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nif not exist node_modules ( npm install )\r\nnpx koishi start\r\n', 'utf8')
console.log('local deployment files written to ' + root)
