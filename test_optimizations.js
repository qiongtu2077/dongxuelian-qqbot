// 自测脚本：验证算法优化前后的行为一致性。
// 仅跑一遍：node test_optimizations.js
'use strict'

// ---------- 旧版本（参考实现）----------
function lcsOld(a, b) {
  const m = a.length
  const n = b.length
  let maxLen = 0
  const dp = new Array(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    let prev = 0
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev + 1
        if (dp[j] > maxLen) maxLen = dp[j]
      } else {
        dp[j] = 0
      }
      prev = temp
    }
  }
  return maxLen
}

function isReplyTooSimilarOld(left, right) {
  const normalize = (t) =>
    String(t).toLowerCase().replace(/\s+/g, '').replace(/[，。！？!?,、：:；;""''·`~～\-]/g, '').trim()
  const L = normalize(left), R = normalize(right)
  if (!L || !R) return false
  if (L === R) return true
  if (Math.min(L.length, R.length) < 8) return false
  if (L.includes(R) || R.includes(L)) return true
  const lcs = lcsOld(L, R)
  return lcs / Math.min(L.length, R.length) >= 0.5
}

function extractAtIdsOld(text = '') {
  const ids = []
  const source = String(text)
  const patterns = [
    /<at(?:\s+[^>]*?)?id="(\d+)"[^>]*\/?>/gi,
    /\[CQ:at,[^\]]*?(?:qq|id)=(\d+)[^\]]*\]/gi,
  ]
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let m
    while ((m = pattern.exec(source))) {
      const u = String(m[1])
      if (!ids.includes(u)) ids.push(u)
    }
  }
  return ids
}

// ---------- 新版本（与插件中实现保持一致）----------
const AT_ID_PATTERN_XML = /<at(?:\s+[^>]*?)?id="(\d+)"[^>]*\/?>/gi
const AT_ID_PATTERN_CQ = /\[CQ:at,[^\]]*?(?:qq|id)=(\d+)[^\]]*\]/gi

function extractAtIdsNew(text = '') {
  const source = String(text)
  const seen = new Set()
  const ids = []
  for (const pattern of [AT_ID_PATTERN_XML, AT_ID_PATTERN_CQ]) {
    pattern.lastIndex = 0
    let m
    while ((m = pattern.exec(source))) {
      const u = m[1]
      if (!seen.has(u)) { seen.add(u); ids.push(u) }
    }
  }
  return ids
}

function lcsNew(a, b, threshold = Infinity) {
  if (!a || !b) return 0
  let outer = a, inner = b
  if (inner.length > outer.length) { outer = b; inner = a }
  const innerLen = inner.length
  const outerLen = outer.length
  const dp = new Array(innerLen + 1).fill(0)
  let maxLen = 0
  for (let i = 1; i <= outerLen; i++) {
    let prev = 0
    const ci = outer.charCodeAt(i - 1)
    for (let j = 1; j <= innerLen; j++) {
      const temp = dp[j]
      if (ci === inner.charCodeAt(j - 1)) {
        const cur = prev + 1
        dp[j] = cur
        if (cur > maxLen) {
          maxLen = cur
          if (maxLen >= threshold) return maxLen
        }
      } else if (temp !== 0) {
        dp[j] = 0
      }
      prev = temp
    }
  }
  return maxLen
}

function normalizeReplyFingerprint(t) {
  return String(t).toLowerCase().replace(/\s+/g, '').replace(/[，。！？!?,、：:；;""''·`~～\-]/g, '').trim()
}

function charSetJaccardOverlap(a, b) {
  const sa = new Set()
  for (let i = 0; i < a.length; i++) sa.add(a.charCodeAt(i))
  let intersect = 0
  const sb = new Set()
  for (let i = 0; i < b.length; i++) {
    const c = b.charCodeAt(i)
    if (sb.has(c)) continue
    sb.add(c)
    if (sa.has(c)) intersect++
  }
  return intersect
}

function isReplyTooSimilarNew(left, right) {
  const L = normalizeReplyFingerprint(left)
  const R = normalizeReplyFingerprint(right)
  if (!L || !R) return false
  if (L === R) return true
  const shorter = Math.min(L.length, R.length)
  if (shorter < 8) return false
  if (L.includes(R) || R.includes(L)) return true
  const threshold = Math.ceil(shorter * 0.5)
  if (charSetJaccardOverlap(L, R) < threshold) return false
  const lcs = lcsNew(L, R, threshold)
  return lcs >= threshold
}

// ---------- 测试 ----------
let pass = 0, fail = 0
function eq(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`) }
}

console.log('--- LCS 等价性 ---')
const lcsCases = [
  ['', ''], ['abc', ''], ['', 'abc'], ['abc', 'abc'],
  ['abcdef', 'zabcz'], ['abcdef', 'xyzabcdefuvw'], ['xxxxx', 'yyyyy'],
  ['你妈的话你信不信', '你妈的话我信你转达'],
  ['先看看自己再说别人', '先去把书读明白再出来丢人'],
  ['你这种废物也配骂人', '你这种货色也配在键盘上撒泼'],
  ['abababab', 'bababab'],
  ['the quick brown fox', 'a quick brown dog'],
]
for (const [a, b] of lcsCases) {
  eq(lcsNew(a, b), lcsOld(a, b), `LCS("${a}","${b}")`)
}

console.log('\n--- LCS 阈值早停（结果只需 >= threshold）---')
for (const [a, b] of lcsCases) {
  const expected = lcsOld(a, b)
  for (const t of [1, 2, 5, 10]) {
    const got = lcsNew(a, b, t)
    // 早停时返回值可能 == threshold（提前退出），也可能 < threshold（没达到）。
    // 充要条件：(expected >= t) === (got >= t)
    eq(got >= t, expected >= t, `LCS("${a}","${b}", t=${t}) >= t`)
  }
}

console.log('\n--- isReplyTooSimilar 等价性 ---')
const simCases = [
  ['', ''], ['你好', '你好'], ['你好啊', '你好呀'],
  ['你这种废物也配骂人，先管好自己那张只会喷粪的嘴',
   '你这种货色也就配在键盘上撒泼，连骂人都得靠复读'],
  ['你妈的话你信不信我帮你转达', '你妈的话我信你帮我转达'],
  ['先看看自己再说别人', '先看看自己'],
  ['完全不同的内容啊啊啊啊啊', '另一段毫无关系的文字哈哈哈'],
  ['短句', '短句子'],  // shorter<8
  ['一二三四五六七八九十', '一二三四五六七八九十'],  // 完全相同
]
for (const [a, b] of simCases) {
  eq(isReplyTooSimilarNew(a, b), isReplyTooSimilarOld(a, b), `sim("${a}","${b}")`)
}

console.log('\n--- extractAtIds 等价性 ---')
const atCases = [
  '',
  '<at id="123"/> 你好 <at id="456"/>',
  '<at id="123"/><at id="123"/> 重复 <at id="456"/>',
  '[CQ:at,qq=789] 混合 <at id="123"/> [CQ:at,id=789]',
  '没有任何 at 标签的纯文本',
  '<at id="111"/> <at id="222"/> <at id="333"/> <at id="111"/>',
]
for (const t of atCases) {
  eq(extractAtIdsNew(t), extractAtIdsOld(t), `extractAtIds(${JSON.stringify(t)})`)
}

console.log('\n--- 性能采样 (LCS 在长串上的差异) ---')
const longA = '你妈的话你信不信我帮你转达'.repeat(40)
const longB = '你妈的话我帮你转达你信不信'.repeat(40)
const N = 200

let t1 = process.hrtime.bigint()
for (let i = 0; i < N; i++) lcsOld(longA, longB)
let t2 = process.hrtime.bigint()
const oldMs = Number(t2 - t1) / 1e6
console.log(`  LCS 旧: ${N} 次 = ${oldMs.toFixed(1)} ms`)

t1 = process.hrtime.bigint()
const threshold = Math.ceil(Math.min(longA.length, longB.length) * 0.5)
for (let i = 0; i < N; i++) lcsNew(longA, longB, threshold)
t2 = process.hrtime.bigint()
const newMs = Number(t2 - t1) / 1e6
console.log(`  LCS 新 (early-stop, threshold=${threshold}): ${N} 次 = ${newMs.toFixed(1)} ms`)

t1 = process.hrtime.bigint()
for (let i = 0; i < N; i++) isReplyTooSimilarOld(longA, longB)
t2 = process.hrtime.bigint()
const simOldMs = Number(t2 - t1) / 1e6

t1 = process.hrtime.bigint()
for (let i = 0; i < N; i++) isReplyTooSimilarNew(longA, longB)
t2 = process.hrtime.bigint()
const simNewMs = Number(t2 - t1) / 1e6

console.log(`  isReplyTooSimilar 旧: ${N} 次 = ${simOldMs.toFixed(1)} ms`)
console.log(`  isReplyTooSimilar 新: ${N} 次 = ${simNewMs.toFixed(1)} ms`)

console.log('\n--- 性能采样 (毫无重叠的长串：Jaccard 应快速否决) ---')
const noOverlapA = 'abcdefghij'.repeat(40)
const noOverlapB = '一二三四五六七八九十'.repeat(40)
t1 = process.hrtime.bigint()
for (let i = 0; i < N; i++) isReplyTooSimilarOld(noOverlapA, noOverlapB)
t2 = process.hrtime.bigint()
const noOldMs = Number(t2 - t1) / 1e6
t1 = process.hrtime.bigint()
for (let i = 0; i < N; i++) isReplyTooSimilarNew(noOverlapA, noOverlapB)
t2 = process.hrtime.bigint()
const noNewMs = Number(t2 - t1) / 1e6
console.log(`  无重叠 旧: ${N} 次 = ${noOldMs.toFixed(1)} ms`)
console.log(`  无重叠 新: ${N} 次 = ${noNewMs.toFixed(1)} ms`)

console.log(`\n汇总: ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
