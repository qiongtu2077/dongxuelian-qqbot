function asTextList(value) {
  return (value || []).map(item => String(item))
}

function formatResult(result = {}) {
  return [
    `sent=${JSON.stringify(asTextList(result.sent))}`,
    `internalCalls=${JSON.stringify(result.internalCalls || [])}`,
    `timeline=${JSON.stringify(result.timeline || [])}`,
    `logs=${JSON.stringify((result.logs || []).map(log => `${log.level}:${log.msg}`).slice(-8))}`,
  ].join(' ')
}

function checkSentIncludes(t, label, result, needle) {
  const sent = asTextList(result.sent)
  t.check(label, sent.some(item => item.includes(needle)), `${JSON.stringify(needle)} not found. ${formatResult(result)}`)
}

function checkSentNonEmpty(t, label, result) {
  const sent = asTextList(result.sent)
  t.check(label, sent.length > 0, formatResult(result))
}

function checkSentExcludes(t, label, result, needle) {
  const sent = asTextList(result.sent)
  t.check(label, !sent.some(item => item.includes(needle)), `${JSON.stringify(needle)} leaked. ${formatResult(result)}`)
}

function checkNoLeak(t, label, result, leaks = ['sk-', 'Bearer', 'reasoning-secret', '我得看看现在是什么情况']) {
  const haystack = [
    ...asTextList(result.sent),
    ...(result.logs || []).map(log => String(log.msg)),
  ].join('\n')
  const leaked = leaks.find(item => haystack.includes(item))
  t.check(label, !leaked, leaked ? `leaked ${JSON.stringify(leaked)}. ${formatResult(result)}` : '')
}

function checkNextCalled(t, label, result) {
  t.check(label, !!result.nextCalled, formatResult(result))
}

function checkInternalCall(t, label, result, method) {
  t.check(label, (result.internalCalls || []).some(call => call.method === method), formatResult(result))
}

function checkNoInternalCall(t, label, result, method) {
  t.check(label, !(result.internalCalls || []).some(call => call.method === method), formatResult(result))
}

module.exports = {
  formatResult,
  checkSentIncludes,
  checkSentNonEmpty,
  checkSentExcludes,
  checkNoLeak,
  checkNextCalled,
  checkInternalCall,
  checkNoInternalCall,
}
