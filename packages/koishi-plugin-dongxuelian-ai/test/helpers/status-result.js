// 同时读取普通回复和合并记录中的状态正文，保留真实适配器发送路径的可观察性。
function readStatusResult(result) {
  return [...result.sent, ...result.internalCalls.filter(call => call.method === 'sendGroupForwardMsg' || call.method === 'sendPrivateForwardMsg').flatMap(call => call.messages.map(node => node.data.content))].join('\n')
}
module.exports = { readStatusResult }
