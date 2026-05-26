/**
 * MODULE: random-persona-risk
 * 职责: 判断随机回复在用户人格覆盖群人格时是否需要更保守的引用策略。
 * 边界: 不读取配置文件、不修改人格绑定、不决定是否发送；只做同步判断。
 * 状态: 无状态。
 */
const { getGroupPersona } = require('./persona')

function getGroupPersonaName(channelKey) {
  const entry = getGroupPersona(channelKey)
  return entry && entry.persona ? String(entry.persona) : ''
}

function isPersonaSwitchRisky(personaResolution, groupPersonaName) {
  return !!(
    personaResolution &&
    personaResolution.source === 'user' &&
    personaResolution.name &&
    String(personaResolution.name) !== String(groupPersonaName || '')
  )
}

module.exports = {
  getGroupPersonaName,
  isPersonaSwitchRisky,
}
