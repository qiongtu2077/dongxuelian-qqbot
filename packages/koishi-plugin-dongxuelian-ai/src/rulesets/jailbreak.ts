const {
  JAILBREAK_INPUT_PATTERN_GROUPS,
  JAILBREAK_INPUT_PATTERNS,
  JAILBREAK_INPUT_RE,
} = require('../core/constants') as typeof import('../core/constants')

function combinePatterns(patterns: RegExp[]): RegExp {
  return new RegExp(patterns.map(pattern => pattern.source).join('|'), 'i')
}

export = {
  combinePatterns,
  JAILBREAK_INPUT_PATTERN_GROUPS,
  JAILBREAK_INPUT_PATTERNS,
  JAILBREAK_INPUT_RE,
}
