/**
 * MODULE: 统一敏感文本脱敏。
 * 职责: 对日志、shell 输出、Agent 材料等用户可见文本做低成本脱敏。
 * 边界: 不判断权限、不解析业务结构。
 */

const AUTH_BEARER_RE = /\b(authorization\s*[:=：]\s*bearer\s+)([^\s,;'"<>]+)/ig
const SECRET_VALUE_RE = /((?:api[_-]?key|token|authorization|password|passwd|secret|cookie|set-cookie|admin[_-]?token)\s*[=:：]\s*)([^\s,;'"<>]+)/ig
const BEARER_RE = /(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/ig
const SK_RE = /\bsk-[A-Za-z0-9][A-Za-z0-9._-]{5,}\b/g
const COOKIE_PAIR_RE = /\b([A-Za-z0-9_.-]*(?:sid|session|token|auth|cookie)[A-Za-z0-9_.-]*=)([^;\s]+)/ig
const SENSITIVE_URL_PARAM_RE = /([?&](?:signature|sign|sig|token|access_token|api_key|apikey|key|secret|auth|session|sid)=)([^&#\s]+)/ig

function redactSensitiveText(text = '') {
  return String(text || '')
    .replace(AUTH_BEARER_RE, '$1[redacted]')
    .replace(SECRET_VALUE_RE, '$1[redacted]')
    .replace(BEARER_RE, '$1[redacted]')
    .replace(SK_RE, 'sk-[redacted]')
    .replace(COOKIE_PAIR_RE, '$1[redacted]')
    .replace(SENSITIVE_URL_PARAM_RE, '$1[redacted]')
}

module.exports = {
  redactSensitiveText,
}
