const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:8080/onebot/v11/ws');
const timer = setTimeout(() => { console.log('TIMEOUT'); ws.close(); process.exit(1); }, 5000);
ws.on('open', () => {
  console.log('WS_OPEN');
  ws.send(JSON.stringify({action:'get_forward_msg', params:{id:'test'}, echo:'t1'}));
});
ws.on('message', (d) => {
  clearTimeout(timer);
  const s = d.toString();
  console.log('RECV:', s.slice(0, 200));
  ws.close();
  process.exit(0);
});
ws.on('error', (e) => {
  clearTimeout(timer);
  console.log('ERR:', e.message);
  process.exit(1);
});
