const fs = require('fs');
const mr = require('./message-reader');

// Simulate a node from NapCat that contains a nested forward CQ code
const mockNode = {
  sender: { user_id: '123456', nickname: '测试用户', card: '' },
  raw_message: '[CQ:forward,id=7633518360129509271,content=[object Object]]',
  message: null  // No parsed segments - triggers CQ fallback
};

// Test CQ regex
const mt = mockNode.raw_message || '';
const cqRe = /\[CQ:forward,id=(\d+)/;
const m = mt.match(cqRe);
console.log('CQ match:', m ? m[1] : 'null');

// Test summarizeForwardNodes with mock data
const mockCn = [
  { type: 'node', data: { nickname: 'A', content: [{ type: 'text', data: { text: 'hello' } }] } },
  { type: 'node', data: { nickname: 'B', content: [{ type: 'text', data: { text: 'world' } }] } }
];

const result = mr.summarizeForwardNodes(mockCn, 0, x => x);
console.log('summarizeForwardNodes result:', result);

// Test if require works inside async callback
async function test() {
  const result2 = await Promise.all([mockNode].map(async function(n) {
    var mt2 = n.raw_message || '';
    var cqRe2 = /\[CQ:forward,id=(\d+)/;
    var m2 = mt2.match(cqRe2);
    console.log('Inside async map, CQ match:', m2 ? m2[1] : 'null');
    return { ok: true, id: m2 ? m2[1] : null };
  }));
  console.log('Async map result:', JSON.stringify(result2));
}

test().then(() => console.log('DONE'));
