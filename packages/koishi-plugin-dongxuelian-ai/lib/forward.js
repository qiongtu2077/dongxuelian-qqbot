const { callGetForwardMsg } = require('./api')
const { summarizeForwardNodes } = require('./message-reader')
const { getChannelKey, lastForwardSummaryCache } = require('./conversation')

async function resolveForwardSummary(session, content, ctx, options = {}) {
  const getForwardMsg = options.callGetForwardMsg || callGetForwardMsg
  let forwardSummaryText = ''
  const fwdM = String(content || '').match(/(?:\[CQ:forward,id=([^,\]]+)\])|<forward\s+id="([^"]+)"\/>/)
  const fwdId = fwdM ? (fwdM[1] || fwdM[2]) : null
  if (fwdId) {
    let fwdData = await getForwardMsg(fwdId)
    ctx.logger('dongxuelian-ai').info('fwd fetch result: ' + (fwdData ? 'ok' : 'null') + ' len=' + (Array.isArray(fwdData) ? fwdData.length : (fwdData && fwdData.messages ? fwdData.messages.length : '?')))
    if (fwdData && Array.isArray(fwdData)) {
      let cn = (await Promise.all(fwdData.map(async function(n) {
        if (n.type === 'node' && n.data) return n
        let s = n.sender || {}
        let nk = (s.card || s.nickname || '').replace(/[\s\u200b-\u200f\u2028-\u202f\ufeff\u3164\uffa0\u115f\u1160-\u11ff]+/g, '').trim() || '群友'
        let mt = n.raw_message || ''
        // 处理原始 CQ 码中的嵌套转发
        if (!mt) mt = ''
        let cqFwdMatch = mt.match(/\[CQ:forward,id=(\d+)/)
        if (cqFwdMatch) {
          let cqInnerData = await getForwardMsg(cqFwdMatch[1])
          ctx.logger('dongxuelian-ai').info('cq inner: id=' + cqFwdMatch[1] + ' result=' + (cqInnerData ? 'ok' : 'null'))
          if (cqInnerData) {
            let cqInnerArr = Array.isArray(cqInnerData) ? cqInnerData : (cqInnerData.messages || null)
            if (cqInnerArr) {
              let cqInnerCn = (await Promise.all(cqInnerArr.map(async function(cn) {
                if (cn.type === 'node' && cn.data) return cn
                let cs = cn.sender || {}
                let cnk = (cs.card || cs.nickname || '').replace(/[\s\u200b-\u200f\u2028-\u202f\ufeff\u3164\uffa0\u115f\u1160-\u11ff]+/g, '').trim() || '群友'
                let cmt = cn.raw_message || ''
                if (cn.message && Array.isArray(cn.message)) {
                  cmt = cn.message.map(function(cm){if(cm.type==='text')return cm.data&&cm.data.text||'';if(cm.type==='face')return'【表情】';if(cm.type==='at')return'@'+(cm.data&&(cm.data.name||cm.data.qq||''));if(cm.type==='image')return'【图片】';return'【消息】'}).filter(Boolean).join('')
                }
                if (!cmt) return null
                return {type:'node',data:{nickname:cnk,content:[{type:'text',data:{text:cmt}}]}}
              }))).filter(Boolean)
              mt = summarizeForwardNodes(cqInnerCn, 0, function(x){return x})
            }
          }
          if (!mt || mt.indexOf('[CQ:forward')>=0) mt = '[嵌套转发：内容暂不可见]'
        } else if (n.message && Array.isArray(n.message)) {
          let fwdIdx = -1
          for (let fi = 0; fi < n.message.length; fi++) {
            if (n.message[fi].type === 'forward' || n.message[fi].type === 'node') { fwdIdx = fi; break }
          }
          if (fwdIdx >= 0) {
            let nestedId = n.message[fwdIdx].data && (n.message[fwdIdx].data.id || n.message[fwdIdx].data['forward-id'] || n.message[fwdIdx].data.res_id)
            if (nestedId) {
              let nestedData = await getForwardMsg(nestedId)
              if (nestedData) {
                let nestedArr = Array.isArray(nestedData) ? nestedData : (nestedData.messages || null)
                if (nestedArr) {
                  let nestedCn = (await Promise.all(nestedArr.map(async function(nn) {
                    if (nn.type === 'node' && nn.data) return nn
                    let ss = nn.sender || {}
                    let nnk = (ss.card || ss.nickname || '').replace(/[\s\u200b-\u200f\u2028-\u202f\ufeff\u3164\uffa0\u115f\u1160-\u11ff]+/g, '').trim() || '群友'
                    let nmt = nn.raw_message || ''
                    if (nn.message && Array.isArray(nn.message)) {
                      nmt = nn.message.map(function(mm){if(mm.type==='text')return mm.data&&mm.data.text||'';if(mm.type==='face')return'【表情】';if(mm.type==='at')return'@'+(mm.data&&(mm.data.name||mm.data.qq||''));if(mm.type==='image')return'【图片】';return'【消息】'}).filter(Boolean).join('')
                    }
                    if (!nmt) return null
                    return {type:'node',data:{nickname:nnk,content:[{type:'text',data:{text:nmt}}]}}
                  }))).filter(Boolean)
                  mt = summarizeForwardNodes(nestedCn, 0, function(x){return x})
                }
              }
            }
            if (!mt || mt.indexOf('[CQ:forward')>=0) mt = '[嵌套转发：内容暂不可见]'
          } else {
            mt = n.message.map(function(m){if(m.type==='text')return m.data&&m.data.text||'';if(m.type==='face')return'【表情】';if(m.type==='at')return'@'+(m.data&&(m.data.name||m.data.qq||''));if(m.type==='image')return'【图片】';return'【消息】'}).filter(Boolean).join('')
          }
        }
        if (!mt) return null
        return {type:'node',data:{nickname:nk,content:[{type:'text',data:{text:mt}}]}}
      }))).filter(Boolean)
      forwardSummaryText = summarizeForwardNodes(cn, 0, function(x){return x})
      ctx.logger('dongxuelian-ai').info('fwd summary len: ' + (forwardSummaryText ? forwardSummaryText.length : 0) + ' text: ' + (forwardSummaryText || '(empty)').slice(0, 100).replace(/\n/g, '\\n'))
      if (forwardSummaryText) lastForwardSummaryCache.set(getChannelKey(session), forwardSummaryText)
    }
  }
  return forwardSummaryText
}

module.exports = {
  resolveForwardSummary,
}
