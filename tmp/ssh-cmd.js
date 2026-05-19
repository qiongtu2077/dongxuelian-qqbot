const { Client } = require('ssh2')
const c = new Client()
const cmd = process.argv[2] || 'echo hi'
c.on('ready', () => {
  c.exec(cmd, (e, s) => {
    if (e) { console.error(e); c.end(); return }
    let d = ''
    s.on('data', b => d += b)
    s.stderr.on('data', b => d += b)
    s.on('close', () => { console.log(d); c.end() })
  })
}).on('error', e => {
  console.error('SSH Error:', e.message)
  process.exit(1)
}).connect({ host: 'YOUR_SERVER_IP', port: 22, username: 'root', password: 'ABcd1234', readyTimeout: 10000 })
