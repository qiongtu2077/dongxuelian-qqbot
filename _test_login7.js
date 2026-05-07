const http = require('http')
const data = JSON.stringify({ password: 'lianlian' })
const req = http.request({ hostname: '127.0.0.1', port: 5150, path: '/dashboard/api/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
  let body = ''
  res.on('data', c => body += c)
  res.on('end', () => { console.log(body); process.exit(0) })
})
req.write(data)
req.end()
