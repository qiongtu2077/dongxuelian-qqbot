const mr = require('/root/koishi-app/packages/koishi-plugin-dongxuelian-ai/lib/message-reader.js');

// Test CQ regex
const cqStr = '[CQ:forward,id=7633518360129509271,content=[object Object]]';
const re = /\[CQ:forward,id=(\d+)/;
const m = cqStr.match(re);
console.log('RE MATCH:', m ? m[1] : 'NULL');

// Test summarizeForwardNodes
const nodes = [
  { type: 'node', data: { nickname: 'A', content: [{ type: 'text', data: { text: 'hello' } }] } },
  { type: 'node', data: { nickname: 'B', content: [{ type: 'text', data: { text: 'world' } }] } }
];
const r = mr.summarizeForwardNodes(nodes, 0, x => x);
console.log('SFN RESULT:', r);
