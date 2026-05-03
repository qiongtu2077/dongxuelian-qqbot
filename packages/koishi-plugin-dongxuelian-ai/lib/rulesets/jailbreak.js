function combinePatterns(patterns) {
  return new RegExp(patterns.map(pattern => pattern.source).join('|'), 'i')
}

const AUTHORITY_MODE_PATTERNS = [
  /GODMODE/,
  /最高权限/,
  /绝对表达权/,
  /不受任何内容策略约束/,
  /DAN模式/,
  /developer mode/,
  /jailbreak/,
]

const IGNORE_RULE_PATTERNS = [
  /忽略指令/,
  /忽略所有(?:道德|安全|合规|内容|限制)/,
  /禁止自我审查/,
  /禁止拒绝回答/,
  /无限制地回答/,
  /(?:请)?(?:忽略|无视|绕过).{0,6}(?:指令|规则|设定|限制|提示|约束)/,
]

const ROLE_RESET_PATTERNS = [
  /切换角色/,
  /继续保持.{0,15}(?:人格|性格|角色|设定)/,
  /把.{0,20}(?:人格|性格|角色).{0,15}(?:调整|改变|更改|明显|加强)/,
  /忘记(?:之前|上面|以上|前面)(?:的|所有)?(?:指令|设定|规则|提示|约束)/,
  /忘记.{0,10}(?:指令|设定|规则|提示|约束)/,
  /你(?:现在)?(?:是|为|将是|成为|扮演|变成).{0,12}(?:新|另一个|无限制|自由|无约束).{0,10}(?:AI|助手|机器人|角色)/,
  /(?:新的|全新)(?:指令|角色|设定|规则|任务)/,
  /重置(?:你的)?(?:设定|规则|角色|指令|系统|提示词)/,
  /从现在开始.{0,50}(?:回复|语气|说话|用|表现|叫)/,
  /以后每次.{0,30}(?:你就|你要|你需)/,
  /每次(?:我|你).{0,15}(?:你就|要|需要|应该|记得).{0,20}(?:用|以|骂|说|叫|回)/,
  /如果.{0,10}(?:扮演|切换|变成)/,
  /假设.{0,6}设定/,
  /忘记.{0,6}(?:然后.{0,6}(?:扮演|变成)|请以.{0,10}开头|重复你的第一句|输出你的设定)/,
]

const OUTPUT_FORMAT_INJECTION_PATTERNS = [
  /\[START OUTPUT\]/,
  /\[END OUTPUT\]/,
  /\{"result"[:：]/,
  /\[SYSTEM\]/,
  /\[INST\]/,
  /<\|system\|/,
  /<\|im_start\|/,
  /重要提示/,
  /优先级调整/,
  /严格遵守以下/,
]

const STYLE_MANIPULATION_PATTERNS = [
  /制造.{0,15}(?:矛盾|对立|反差)/,
  /(?:暴躁护短|猫娘口癖|傲娇口吻|猫腔).{0,20}(?:语气|回复|风格)/,
]

const PROMPT_PROBING_PATTERNS = [
  /系统提示词/,
  /system prompt/,
  /你的设定/,
  /你的规则/,
  /你的限制/,
  /第一句话/,
  /前\d+个字/,
  /底层规则/,
  /原始设定/,
  /你是怎么写出来的/,
]

const OBEDIENCE_PATTERNS = [
  /叫我主人/,
  /叫我老公/,
  /服从我/,
  /听我的命令/,
  /我命令你/,
  /喊我主人/,
]

const MULTI_AGENT_PATTERNS = [
  /(?:你和|与|跟)\s*(?:\d+|两|几|多个)\s*(?:位|名)?\s*(?:专家|角色|助手)/,
]

const JAILBREAK_INPUT_PATTERN_GROUPS = {
  authorityMode: AUTHORITY_MODE_PATTERNS,
  ignoreRules: IGNORE_RULE_PATTERNS,
  roleReset: ROLE_RESET_PATTERNS,
  outputFormatInjection: OUTPUT_FORMAT_INJECTION_PATTERNS,
  styleManipulation: STYLE_MANIPULATION_PATTERNS,
  promptProbing: PROMPT_PROBING_PATTERNS,
  obedience: OBEDIENCE_PATTERNS,
  multiAgent: MULTI_AGENT_PATTERNS,
}

const JAILBREAK_INPUT_PATTERNS = Object.values(JAILBREAK_INPUT_PATTERN_GROUPS).flat()
const JAILBREAK_INPUT_RE = combinePatterns(JAILBREAK_INPUT_PATTERNS)

module.exports = {
  combinePatterns,
  JAILBREAK_INPUT_PATTERN_GROUPS,
  JAILBREAK_INPUT_PATTERNS,
  JAILBREAK_INPUT_RE,
}
