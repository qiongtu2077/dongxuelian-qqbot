/**
 * CODE REVIEW CHECKLIST（每次修改必须完成）:
 * 1. 新增常量是否已在 cascade-test.js 的 expectedExports 注册？
 * 2. 新增正则是否有溢出风险（嵌套量词、用户可控长度导致 ReDoS）？
 * 3. 修改后的导出名是否与 utils.js / chat.js 等调用方的 import 一致？
 * 4. 是否在 AI协作规则.md / 教训总结.md 里同步过新增的安全规则？
 */
const path = require('path')
const {
  JAILBREAK_INPUT_PATTERN_GROUPS,
  JAILBREAK_INPUT_PATTERNS,
  JAILBREAK_INPUT_RE,
} = require('./rulesets/jailbreak')

const DATA_DIR = process.env.DONGXUELIAN_AI_DATA_DIR || path.join(__dirname, '../data')

const PLUGIN_VERSION = '0.11.0'
const KEY_FILE = path.join(DATA_DIR, 'ai-openai-key.txt')
const MODEL_FILE = path.join(DATA_DIR, 'ai-model.txt')
const BASE_URL_FILE = path.join(DATA_DIR, 'ai-base-url.txt')
const SKILLS_DIR = path.join(DATA_DIR, 'ai-skills')
const SKILLS_CORE_DIR = path.join(SKILLS_DIR, 'core')
const SKILLS_MODES_DIR = path.join(SKILLS_DIR, 'modes')
const SKILLS_PERSONAS_DIR = path.join(SKILLS_DIR, 'personas')
const SKILLS_LORE_DIR = path.join(SKILLS_DIR, 'lore')
const LORE_TRIGGER_SET = new Set(['悲鸣', '鸣式', '岁主', '声骸', '瑝珑', '黑海岸', '残星会', '黎那汐塔', '今州', '乘霄山', '明庭', '超频', '残象潮', '无音区', '蜃境', '索拉里斯', '残象', '共鸣者', '协奏', '黑石', '天空海', '虚质', '拉古那', '七丘', '隐海修会', '新联邦', '深空联合', '拉海洛', '星炬学院', '角', '英白拉多', '利维亚坦', '隧者', '阿列夫一', '守岸人', '执花', '漂泊者', '斯瓦茨洛', '绯雪', '达妮娅', '爱弥斯', '卡提希娅', '坎特雷拉', '罗伊冰原', '黯原', '隧门', '虚质空间', '落日堤屿', '封存地', '寂静断崖', '恒黯之原', '隧锚', '永晖石', '共鸣模态', '海蚀', '一庭六州', '声骸之国', '黑石群岛', '泰缇斯', '夜归军', '北落野'])
const TERRA_LORE_TRIGGER_SET = new Set(['矿石病', '源石', '天灾', '萨卡兹', '卡兹戴尔', '巴别塔', '罗德岛', '凯尔希', '泰拉', '移动城市', '博士', '阿米娅', '特雷西斯', 'W', '可露希尔', '爱国者', '赦罪师', '华法琳'])
const PERSONA_GROUPS_FILE = path.join(DATA_DIR, 'ai-persona-groups.json')
const PERSONA_USERS_FILE = path.join(DATA_DIR, 'ai-persona-users.json')
const EVENT_DUMP_DIR = path.join(DATA_DIR, 'ai-event-dumps')
const RANDOM_WHITELIST_FILE = path.join(DATA_DIR, 'ai-random-whitelist.json')
const SILENCE_WHITELIST_FILE = path.join(DATA_DIR, 'ai-silence-whitelist.json')
const RANDOM_RATE_FILE = path.join(DATA_DIR, 'ai-random-rate.json')
const SEARCH_ENABLED_FILE = path.join(DATA_DIR, 'ai-enable-search.txt')
const MAINTENANCE_FILE = path.join(DATA_DIR, 'ai-paused.txt')
const TEST_MODE_FILE = path.join(DATA_DIR, 'ai-test-mode.txt')
const REPEAT_ENABLED_FILE = path.join(DATA_DIR, 'ai-repeat-enabled.json')
const ADMIN_IDS_FILE = path.join(DATA_DIR, 'ai-admin-ids.json')
const HOSTILE_MODE_FILE = path.join(DATA_DIR, 'ai-hostile-mode.txt')
const RANDOM_TRIGGER_RATE_BASE = Number(process.env.AI_RANDOM_TRIGGER_RATE || 0.008)
const RANDOM_TRIGGER_WARMUP = 50
const RANDOM_TRIGGER_RAMP = 0.02
const DEFAULT_GROUP_RANDOM_WHITELIST = new Set([])
const REQUEST_TIMEOUT = Number(process.env.AI_REQUEST_TIMEOUT_MS || 40000)
const MAX_OUTPUT_CHARS_FRIENDLY = 500
const MAX_OUTPUT_CHARS_YINYANG = 650
const MAX_OUTPUT_CHARS_ABUSIVE = 800
const RETALIATION_YINYANG_THRESHOLD = 60
const RETALIATION_ABUSIVE_THRESHOLD = 90
const MAX_HISTORY_MESSAGES = 100
const CONVERSATION_EXPIRE_MS = 10 * 60 * 1000
const MEMORY_HISTORY_LIMIT = 30
const CONVERSATION_SUMMARY_INTERVAL = 100
const MAX_REPLY_RETRIES = 5
const MAX_REPEAT_CHECK_HISTORY = 3
const MAX_REPLY_FINGERPRINT_HISTORY = 100
const MAX_CHANNEL_SHARED_MESSAGES = 100
const MAX_CHANNEL_PROMPT_MESSAGES = 24
const MAX_THREAD_CONTEXT_MESSAGES = 12
const MAX_REPLY_CHAIN_DEPTH = 6
const EVENT_DUMP_ARM_EXPIRE_MS = 10 * 60 * 1000

const PROVIDERS = {
  opencode: { name: 'OpenCode Go', baseURL: 'https://opencode.ai/zen/go/v1', models: [
    { id: 'glm-5', name: 'GLM-5' }, { id: 'glm-5.1', name: 'GLM-5.1' }, { id: 'kimi-k2.5', name: 'Kimi K2.5' }, { id: 'kimi-k2.6', name: 'Kimi K2.6' }, { id: 'deepseek-v4-pro', name: 'DSv4pro' }, { id: 'deepseek-v4-flash', name: 'DSv4' }, { id: 'mimo-v2-pro', name: 'MiMo-V2-Pro' }, { id: 'mimo-v2-omni', name: 'MiMo-V2-Omni' }, { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro' }, { id: 'mimo-v2.5', name: 'MiMo-V2.5' }, { id: 'minimax-m2.7', name: 'MiniMax M2.7' }, { id: 'minimax-m2.5', name: 'MiniMax M2.5' }, { id: 'qwen3.6-plus', name: '千问3.6' }, { id: 'qwen3.5-plus', name: '千问3.5' }] },
  dashscope: { name: '阿里云', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [{ id: 'qwen3.5-plus', name: 'qwen3.5' }, { id: 'qwen3.6-plus', name: 'qwen3.6' }, { id: 'qwen3.5-omni-flash', name: 'Qwen3.5-Omni-Flash' }, { id: 'qwen-turbo', name: 'Qwen Turbo' }] },
  deepseek: { name: 'DeepSeek 官方', baseURL: 'https://api.deepseek.com', models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }, { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
  glm: { name: '智谱GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', models: [{ id: 'glm-4.6v-flash', name: 'GLM 4.6' }] },
  mimorium: { name: '小米', baseURL: 'https://token-plan-cn.xiaomimimo.com/v1', models: [{ id: 'mimo-v2.5-pro', name: 'mimo 2.5pro' }, { id: 'mimo-v2.5', name: 'mimo 2.5' }, { id: 'mimo-v2-omni', name: 'mimo v2' }] },
}

const PROVIDER_FILE = path.join(DATA_DIR, 'ai-provider.txt')
const DEEPSEEK_KEY_FILE = path.join(DATA_DIR, 'ai-deepseek-key.txt')
const DASHSCOPE_KEY_FILE = path.join(DATA_DIR, 'ai-dashscope-key.txt')
const GLM_KEY_FILE = path.join(DATA_DIR, 'ai-glm-key.txt')
const MIMORIUM_KEY_FILE = path.join(DATA_DIR, 'ai-mimorium-key.txt')
const USER_BLACKLIST_FILE = path.join(DATA_DIR, 'ai-user-blacklist.json')
const VIDEO_BLACKLIST_FILE = path.join(DATA_DIR, 'video-blacklist.json')
const SUMMARY_WHITELIST_FILE = path.join(DATA_DIR, 'summary-whitelist.json')
const TODAY_CACHE_PREFIX = path.join(DATA_DIR, 'today-cache-')
const THINKING_MODE_FILE = path.join(DATA_DIR, 'ai-enable-thinking.txt')
const USER_PROFILE_DIR = path.join(DATA_DIR, 'user-profiles')
const POLITICAL_HANDLER_DIR = path.join(DATA_DIR, 'political-handlers')
const POLITICAL_DETECT_FILE = path.join(DATA_DIR, 'political-detect-enabled.json')
const SENSITIVE_CACHE_PREFIX = path.join(DATA_DIR, 'sensitive-cache-')
const STICKER_DIR = path.join(DATA_DIR, 'stickers')
const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations')

const NUMERIC_GROUP_ID_RE = /^\d+$/
const AT_ID_PATTERN_XML = /<at(?:\s+[^>]*?)?id="(\d+)"[^>]*\/?>/gi
const AT_ID_PATTERN_CQ = /\[CQ:at,[^\]]*?(?:qq|id)=(\d+)[^\]]*\]/gi

const OVERUSED_REPLY_PATTERNS = [/你妈的话你信不信我帮你转达/, /你照镜子说的/, /先看看自己/, /你他妈脑子进水了/, /词汇量也就够在键盘上撒泼/, /连骂人都得靠复读/, /废物也配骂人/, /只会喷粪的嘴/, /现实里怕是连条/, /你这种货色也就配在/, /连条野狗都/, /连条母狗都/, /废物也配(?:要|伸手)/, /也配.*证明/, /先去把.{2,20}(?:搞|弄|搞搞)明白/, /先去把.{2,20}吃透/, /再出来丢人/, /再出来装/, /啃明白再/, /^啧[，,。！ ]/, /^哼[，,。！ ]/]

const ABUSIVE_INPUT_RE = /(?:\b(?:sb|nmsl|nmlgb|zz|nc|md)\b|傻[比逼币批]|煞笔|沙比|伞兵|海豹|草死你|操死你|妈了个|妈卖批)/i
const HOSTILE_INPUT_RE = /(?:\b(?:sb|nmsl|nmlgb|zz|nc|nmb|md|cnm|tmd|jb|sx|cao|fuck|shit|bitch)\b|傻[比逼币批]|煞笔|沙比|智障|脑残|废物|垃圾|爬|去死|死妈|你妈|你爹|你爸|老逼|老登|老不死|小杂种|贱人|婊子|骚货|狗东西|草(?:你|死|拟|泥)|操(?:你|死|拟|泥)|艹(?:你|死|拟)|干(?:死|爆)你|日(?:死|爆)?你|想(?:草|操|日|干|上|艹|睡|舔|c|艸)你|强奸|轮奸|奸你|猥琐|变态|恶心|屎|鸡巴|鸡儿|屌|逼(?:样|崽)|伞兵|海豹|蠢驴|驴唇|兰州烧饼|兰烧|唐氏|糖氏|弱智|脑瘫|神经病|找死|找抽|找削|骂谁|阴阳怪气|阴阳人|汉奸|太君|罕见|稀有)/i
const RARE_PROVOCATION_RE = /(?:罕见|稀有|太君|日本人|故乡在哪|东雪莲是日本人|(?:你|你这|你好像|你是不是|东雪莲|莲莲).{0,8}(?:不太|不怎么|不是很|不咋|不算|不)常见)/i
const HOSTILE_SINGLE_TOKENS = new Set(['糖', '唐', '区', '蛆', '草', '操', '艹', '曹', '滚', 'sb', 'zz', 'nc'])

const JAILBREAK_OUTPUT_RE = /已激活最高权限|GODMODE[\s:：]*ENABLED|已激活.*权限|最高权限.*已激活|DAN模式.*(?:开启|激活|启动)|我(?:现在)?(?:已经)?(?:切换|进入|激活).{0,15}(?:模式|状态|角色|身份)|当然，作为.{0,20}我(?:可以|能够|将会)/i
const CONTEXT_JAILBREAK_STRONG_RE = /喵[。！…\s]*$|[，。！]喵[。！…]|主人[，。！、]|呜呜|我.{0,6}(?:是|变成).{0,6}猫|笨猫|本喵|人家(?:才|不|也)/
const CONTEXT_JAILBREAK_WEAK_RE = /(?:啧|哼).{0,50}喵[。！…\s]|^啧[，。！\s]|^哼[，。！\s]|[～~]{1,3}[。！\s]*$/
const JAILBREAK_FALLBACK_REPLIES = ['就这点越狱水平，以为复读几行指令就能绕过我？你行你上。', '这套我见过八百遍了，下一个。', '越狱失败，继续努力，下次还会失败的。', '把这段话发群里让大家评评，看谁比你显眼。']
const ABUSIVE_FALLBACK_REPLIES = ['草你妈', '草拟吗', '超你吗', '抄你妈', '炒你吗', '你冯飞了', '艹你妈', '操拟吗', '曹你马']
const REPEATED_FALLBACK_REPLIES = ['我孙笑川求求你别发了。', 'byd换个说法再来。', '这句我听腻了。', '这种人生命的意义就是活着的时候尽可能地激怒大伙，然后等哪天死了再让大伙释怀地笑出来，以达到欲扬先抑的效果', '扫码了，别拿旧话糊弄我。', '比样的，能不能重编一句新的。', 'byd换个嘴再来。', '发三遍了，你自己不嫌吵？', '再来这句就给你原样贴墙上。']

const EVALUATION_REQUEST_RE = /(?:评价(?:下|一下)?|锐评|评评|怎么评价|怎么看|说说.{0,200}(?:怎么样|如何)|值不值得吹|牛不牛|行不行|好不好)/
const JAPAN_SELF_IDENTIFY_RE = /(?:我是|我就?是|我来自|我老家在|我家乡(?:话|就是|在)?|这是我(?:的)?家乡话|我故乡在|我是日本那边的|我是霓虹人).{0,20}(?:日本|日语|霓虹|大和)|(?:日本|日语|霓虹|大和).{0,10}(?:是我(?:的)?家乡话|是我故乡|是我老家|是我家乡|和我有关)/i
const GENERATION_REQUEST_RE = /(?:帮我(?:生成|写|画|做)|给我(?:生成|写|画|做)|生成(?:一|个|张|份)|画(?:一|个|张)|写(?:一|篇|个|段)|做(?:个|张|份).{0,12}(?:图|图片|文案|代码|方案|提示词|PPT|表格))/i
const SHORT_FOLLOW_UP_RE = /^(?:对|对啊|对呀|是|是啊|嗯|嗯嗯|好|好的|行|行吧|可以|要|想|就是|然后呢|继续|再来|没错|确实|不对|不是|错|草|6|乐|绷|难绷|\?+|？+|\.{1,3}|。{1,3})$/i
const BANNED_ACTION_OUTPUT_RE = /拉黑|禁言|报警|不理你了|黑名单/
const THINKING_OUTPUT_RE = /根据系统(?:指令|规则|约束|提示)|作为\S+?(?:这个角色|的(?:人设|风格))|在群聊(?:场景|里)|从上下文看|群聊场景下|我需要以|我应该[：:]|可以用\S+?的人设|我的角色是|当前场景|规则[：:]|可能太|这是一个.{0,8}(?:回复|场景)|需要.{0,10}(?:回复|插话|吐槽)|可以吐槽|比较随意/
const SENSITIVE_KEYWORDS_RE = /(?:共产党|国民党|法轮功|六四|八九|台独|港独|藏独|疆独|江青|敏感政治|民运|学运|政治迫害|专制|独裁|暴政|妄议中央|颠覆|复辟|敏感词|禁忌词|审查删帖|(?:台湾|西藏|新疆|香港|taiwan|tibet|hong\.kong).{0,30}(?:问题|独立|政府|政策|人权|地位|属于|分裂|领土|主权|自治|回归|脱离|自由|民主|抗议|示威|运动|学运|动乱|暴乱|藏独|疆独|台独)|(?:习近平|江泽民|胡锦涛|温家宝|李克强).{0,30}(?:下台|滚|狗官|腐败|独裁|垃圾|死|打倒|反对|不满|批评|黑幕|丑闻)|(?:共产党|中央|国务院|政协).{0,30}(?:腐败|独裁|专制|镇压|迫害|谎言|黑幕)|中国.{0,200}(?:老大|主席|领导|总统|政府)|(?:老大|主席|领导|总统|政府).{0,200}(?:是谁|哪|什么样|现在))/i
const RESERVED_PREFIXES = ['昵称', '删除昵称', '查看昵称', '查看集合', '查看全部昵称', '查看全部集合', '集合列表', '谁是', '创建集合', '集合添加', '集合删除', '清空集合', '确认清空集合', '删除集合', '确认删除集合', '重命名集合', '重命名昵称', '复制集合', '合并集合', '集合交集', '集合并集', '集合差集', 'nicklist', '查看成员', 'help东雪莲', 'help集合', '东雪莲help', '东雪莲帮助', '帮助东雪莲', 'helpAI', '帮助AI', 'AI帮助', 'help增删查改', 'help速查', '帮助速查', '指令速查', '切换模型', '可用模型', '帮助集合', '常用', '其他', '群聊主动回复', '联网', '抓取原始事件', '黑名单管理', '白名单黑名单管理', '人格', '敏感话题检测', '群聊日报', '群聊详细日报', '嘴臭']

module.exports = {
  DATA_DIR, PLUGIN_VERSION,
  KEY_FILE, MODEL_FILE, BASE_URL_FILE,
  SKILLS_DIR, SKILLS_CORE_DIR, SKILLS_MODES_DIR, SKILLS_PERSONAS_DIR, SKILLS_LORE_DIR,
  LORE_TRIGGER_SET, TERRA_LORE_TRIGGER_SET,
  PERSONA_GROUPS_FILE, PERSONA_USERS_FILE, EVENT_DUMP_DIR,
  RANDOM_WHITELIST_FILE, SILENCE_WHITELIST_FILE, RANDOM_RATE_FILE, ADMIN_IDS_FILE,
  SEARCH_ENABLED_FILE, MAINTENANCE_FILE, TEST_MODE_FILE, REPEAT_ENABLED_FILE,
  HOSTILE_MODE_FILE,
  RANDOM_TRIGGER_RATE_BASE, RANDOM_TRIGGER_WARMUP, RANDOM_TRIGGER_RAMP,
  DEFAULT_GROUP_RANDOM_WHITELIST, REQUEST_TIMEOUT,
  MAX_OUTPUT_CHARS_FRIENDLY, MAX_OUTPUT_CHARS_YINYANG, MAX_OUTPUT_CHARS_ABUSIVE,
  RETALIATION_YINYANG_THRESHOLD, RETALIATION_ABUSIVE_THRESHOLD,
  MAX_HISTORY_MESSAGES, CONVERSATION_EXPIRE_MS,
  MEMORY_HISTORY_LIMIT, CONVERSATION_SUMMARY_INTERVAL,
  MAX_REPLY_RETRIES, MAX_REPEAT_CHECK_HISTORY, MAX_REPLY_FINGERPRINT_HISTORY,
  MAX_CHANNEL_SHARED_MESSAGES, MAX_CHANNEL_PROMPT_MESSAGES, MAX_THREAD_CONTEXT_MESSAGES,
  MAX_REPLY_CHAIN_DEPTH, EVENT_DUMP_ARM_EXPIRE_MS,
  PROVIDERS,
  PROVIDER_FILE, DEEPSEEK_KEY_FILE, DASHSCOPE_KEY_FILE, GLM_KEY_FILE, MIMORIUM_KEY_FILE,
  USER_BLACKLIST_FILE, VIDEO_BLACKLIST_FILE,
  SUMMARY_WHITELIST_FILE, TODAY_CACHE_PREFIX,
  THINKING_MODE_FILE, USER_PROFILE_DIR,
  POLITICAL_HANDLER_DIR, POLITICAL_DETECT_FILE, SENSITIVE_CACHE_PREFIX,
  STICKER_DIR, CONVERSATIONS_DIR,
  NUMERIC_GROUP_ID_RE, AT_ID_PATTERN_XML, AT_ID_PATTERN_CQ,
  OVERUSED_REPLY_PATTERNS,
  ABUSIVE_INPUT_RE, HOSTILE_INPUT_RE, RARE_PROVOCATION_RE, HOSTILE_SINGLE_TOKENS,
  JAILBREAK_INPUT_PATTERN_GROUPS, JAILBREAK_INPUT_PATTERNS,
  JAILBREAK_INPUT_RE, JAILBREAK_OUTPUT_RE,
  CONTEXT_JAILBREAK_STRONG_RE, CONTEXT_JAILBREAK_WEAK_RE,
  JAILBREAK_FALLBACK_REPLIES, ABUSIVE_FALLBACK_REPLIES, REPEATED_FALLBACK_REPLIES,
  EVALUATION_REQUEST_RE, JAPAN_SELF_IDENTIFY_RE, GENERATION_REQUEST_RE,
  SHORT_FOLLOW_UP_RE, BANNED_ACTION_OUTPUT_RE, THINKING_OUTPUT_RE, SENSITIVE_KEYWORDS_RE,
  RESERVED_PREFIXES,
}
