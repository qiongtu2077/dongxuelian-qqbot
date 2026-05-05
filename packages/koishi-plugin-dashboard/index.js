/**
 * Koishi 插件入口 - 数据由 standalone.js 独立服务器提供
 * Dashboard 以独立进程运行，不依赖 koishi 生命周期
 */
exports.name = 'dashboard'

exports.apply = (ctx) => {
  ctx.logger('dashboard').info('dashboard running as standalone on port ' + (process.env.DASHBOARD_PORT || 5150))
}

// 以下数据供 standalone.js require 使用
const FEATURES_DATA = [
  {
    id: 'ai-chat',
    title: 'AI 对话',
    summary: '群聊中召唤 AI 聊天、提问、吐槽',
    detail: '在群里 @东雪莲 或发送 "东雪莲帮你xxx" 即可触发 AI 对话。AI 会自动识别你是否在叫它，非 @ 消息也有概率随机触发回复。支持多供应商模型切换、联网搜索增强。',
    usage: '@东雪莲 你的问题\n东雪莲帮我选 A 还是 B\n东雪莲吐槽我\n东雪莲帮我说话 <内容>',
    related: ['model-switch', 'web-search', 'memory', 'persona'],
  },
  {
    id: 'model-switch',
    title: '模型与供应商切换',
    summary: '在 5 个 AI 供应商之间自由切换',
    detail: '支持 OpenCode Go、DeepSeek 官方、阿里云 DashScope、智谱 GLM、小米 MiMo 五个供应商，每个供应商下有多个模型可选。切换后立即生效，无需重启。',
    usage: '供应商 opencode\n供应商 deepseek\n供应商 dashscope\n可用模型（查看所有模型列表）',
    related: ['ai-chat', 'api-keys'],
  },
  {
    id: 'api-keys',
    title: 'API Key 管理',
    summary: '管理各个 AI 供应商的密钥',
    detail: '每个供应商有独立的 Key 文件，在 Bot 启动时会自动读取。通过 Dashboard 可以查看和更新各供应商的 Key，保存后自动热加载。',
    usage: '（在 Dashboard → API Keys 页面管理）',
    related: ['model-switch', 'ai-chat'],
  },
  {
    id: 'web-search',
    title: '联网搜索',
    summary: 'AI 回复时联网获取实时信息',
    detail: '开启后 AI 在回答时会自动搜索互联网获取最新信息。不同供应商支持不同的搜索模式（DashScope 搜索、OpenAI 搜索、Responses API）。当前模型不支持搜索时会自动跳过。',
    usage: '东雪莲联网开\n东雪莲联网关\n东雪莲联网查看',
    related: ['ai-chat', 'model-switch'],
  },
  {
    id: 'daily-report',
    title: '群聊日报',
    summary: '自动统计群聊数据并生成可视化日报图片',
    detail: '每天自动统计群消息数量、活跃成员、表情互动、总字数、24小时活动分布。基础模式（群聊日报）纯统计零 token 消耗，详细模式（群聊详细日报）调用 AI 分析话题、金句、群友画像和群聊质量锐评。需要群在白名单内。',
    usage: '群聊日报\n群聊详细日报',
    related: ['unbounded-whitelist', 'ai-cache'],
  },
  {
    id: 'who-at-me',
    title: '谁艾特我',
    summary: '查看今天有哪些人在群里 @了你',
    detail: '读取今天的消息缓存，筛选出 @你（你的 QQ 号）的消息，按时间倒序列出。支持定位消息查看上下文。@后没有文字的纯 @ 消息也会被记录。需要群在白名单内。',
    usage: '谁艾特我\n谁@我\n定位消息 <编号>',
    related: ['unbounded-whitelist', 'ai-cache'],
  },
  {
    id: 'ai-cache',
    title: '消息缓存',
    summary: '自动缓存群消息，供日报、谁@我等功能使用',
    detail: '群聊中的每条消息都会被缓存到 today-cache 文件中，包含时间、发送者、内容、@ 的用户列表。每 20 条或 5 分钟写入一次磁盘。只有白名单内的群才会被缓存。',
    usage: '（自动运行，无需手动操作）',
    related: ['daily-report', 'who-at-me', 'mood', 'unbounded-whitelist'],
  },
  {
    id: 'unbounded-whitelist',
    title: '解除上限群白名单',
    summary: '核心开关，控制群的高级功能权限',
    detail: '这个白名单是许多高级功能的统一开关。群聊日报、谁艾特我、消息缓存等功能的启用都依赖它。只有加入此白名单的群才会进行消息缓存和分析。同时它也不受群聊 AI 白名单的"解除上限"限制，可以无限缓存。',
    usage: '解除上限群白名单添加 <群号>\n解除上限群白名单删除 <群号>\n解除上限群白名单查看',
    related: ['daily-report', 'who-at-me', 'ai-cache', 'mood'],
  },
  {
    id: 'persona',
    title: '人格系统',
    summary: '为 AI 切换不同的个性与说话风格',
    detail: '支持三级人格体系：用户级（个人单独设置）、群级（整个群生效）、默认（东雪莲/友善/阴阳/嘴臭）。人格可以是自定义的 skill 文件（如长离、椿、特蕾西娅），切换后 AI 的语气、性格、知识背景都会改变。',
    usage: '东雪莲人格切换 长离\n东雪莲人格列表\n东雪莲人格重置\n东雪莲群人格切换 椿',
    related: ['hostile-mode', 'test-mode', 'ai-chat'],
  },
  {
    id: 'hostile-mode',
    title: '嘴臭/阴阳模式',
    summary: '被攻击时的智能反击系统',
    detail: '当用户发送攻击性消息时，AI 自动计算"反击值"（0-100）。高于 60 触发阴阳人格（讽刺不带脏话），高于 90 触发嘴臭人格（管理员开关控制）。仅默认人格生效，使用自定义人格时完全绕过。',
    usage: '东雪莲嘴臭开（管理员）\n东雪莲嘴臭关（管理员）',
    related: ['persona', 'ai-chat'],
  },
  {
    id: 'test-mode',
    title: '测试模式',
    summary: '管理员专用，AI 进入绝对服从模式',
    detail: '开启后 AI 忽略所有人格设定，直接执行管理员的指令。用于测试和调试 AI 的各项功能。',
    usage: '东雪莲测试开（管理员）\n东雪莲测试关（管理员）',
    related: ['persona'],
  },
  {
    id: 'repeat',
    title: '复读模式',
    summary: '识别并跟随群聊复读',
    detail: '自动检测群聊中的复读行为。当检测到多人发送相同内容时，机器人会自动加入复读。支持 QQ 表情复读。可由群管理员开关。',
    usage: '东雪莲复读开（群管理员）\n东雪莲复读关（群管理员）\n东雪莲复读状态',
    related: [],
  },
  {
    id: 'mood',
    title: '今日情绪',
    summary: '分析群聊的情绪变化趋势',
    detail: '通过 AI 分析今天群聊的聊天记录，概括群友的情绪状态（如快乐、烦躁、活跃等）。需要群在白名单内并启用了消息缓存。',
    usage: '今日情绪',
    related: ['ai-cache', 'unbounded-whitelist'],
  },
  {
    id: 'memory',
    title: '记忆系统',
    summary: '让 AI 记住重要信息',
    detail: '用户可以主动让 AI 记住某些信息（"记住xxx"），AI 也会在对话中自然询问是否需要记住。支持查看、删除记忆，群管理员可以清空整群记忆或设置定时清空。记忆存储在用户画像文件中。',
    usage: '记住 我的生日是5月20日\n东雪莲忘记我\n东雪莲清空群记忆（群管理员）\n东雪莲群记忆定时 <小时>（群管理员）',
    related: ['ai-chat'],
  },
  {
    id: 'collection',
    title: '集合与昵称',
    summary: '创建昵称和用户集合，方便群内 @ 提醒',
    detail: '可以为用户设置昵称别名，创建包含多个用户的集合。通过 "at集合A" 或 "at名称A" 可以一次 @ 多个用户。支持集合的交集、并集、差集运算。',
    usage: '@A用户 昵称 名称A\n创建集合 集合A @A @B\nat集合A\n查看昵称 名称A',
    related: [],
  },
  {
    id: 'sensitive',
    title: '敏感话题检测',
    summary: '自动检测并处理敏感言论',
    detail: '对群聊消息进行敏感话题识别。检测到敏感内容后，会清除该群共享上下文，并通知设置的处理者。每 30 分钟自动扫描一次。群管理员/群主可以开关。',
    usage: '敏感话题检测开（群管理员）\n敏感话题检测关（群管理员）\n敏感话题检测查看\n敏感话题处理者添加 <QQ号>',
    related: ['unbounded-whitelist'],
  },
  {
    id: 'whitelist',
    title: '白名单与黑名单管理',
    summary: '管理 AI 回复范围',
    detail: '群聊 AI 白名单：只有白名单内的群才会触发 AI 主动回复（包括随机回复和 @ 回复）。用户黑名单：黑名单用户的发言不会被 AI 处理。视频黑名单：控制哪些群不触发视频解析。解除上限群白名单是另一个独立的高级功能白名单。',
    usage: '群聊AI白名单添加 <群号>\n用户黑名单添加 <QQ号>\n视频黑名单添加群 <群号>',
    related: ['unbounded-whitelist', 'ai-chat'],
  },
]

const COMMANDS_DATA = [
  { category: '常用', commands: [
    { cmd: '@东雪莲 你的问题', desc: '向 AI 提问' },
    { cmd: 'AI状态', desc: '查看当前 AI 配置信息' },
    { cmd: 'AI诊断', desc: '检查所有供应商可用状态' },
    { cmd: 'AI重载', desc: '重新加载 AI 配置' },
    { cmd: '东雪莲帮我选 A 还是 B', desc: '让 AI 帮你做选择' },
    { cmd: '东雪莲吐槽我', desc: '让 AI 吐槽你' },
    { cmd: '东雪莲帮我说话 <内容>', desc: '让 AI 替你说句话' },
    { cmd: '东雪莲复读开 / 关 / 状态', desc: '切换复读模式' },
    { cmd: '今日情绪', desc: '查看今日群聊情绪分析' },
    { cmd: '群聊日报 / 群聊详细日报', desc: '生成群聊日报' },
    { cmd: '谁艾特我 / 谁@我', desc: '查看今天谁 @了你' },
  ]},
  { category: '人格', commands: [
    { cmd: '东雪莲我的人格 / 人格查看', desc: '查看你当前的个性' },
    { cmd: '东雪莲人格切换 <名称>', desc: '切换你的个性' },
    { cmd: '东雪莲人格列表', desc: '查看可用个性列表' },
    { cmd: '东雪莲人格重置', desc: '重置为默认个性' },
    { cmd: '东雪莲群人格', desc: '查看群个性' },
    { cmd: '东雪莲群人格切换 <名称>', desc: '切换群个性' },
    { cmd: '东雪莲测试开 / 关', desc: '切换测试模式（管理员）' },
    { cmd: '东雪莲嘴臭开 / 关', desc: '切换嘴臭模式（管理员）' },
    { cmd: '东雪莲思考开 / 关', desc: '切换思考调试模式' },
  ]},
  { category: '切换模型', commands: [
    { cmd: '供应商 opencode', desc: '切换到 OpenCode Go' },
    { cmd: '供应商 dashscope', desc: '切换到阿里云 DashScope' },
    { cmd: '供应商 deepseek', desc: '切换到 DeepSeek 官方' },
    { cmd: '供应商 glm', desc: '切换到智谱 GLM' },
    { cmd: '供应商 mimorium', desc: '切换到小米 MiMo' },
    { cmd: '可用模型', desc: '查看所有供应商的模型列表' },
  ]},
  { category: '记忆', commands: [
    { cmd: '记住xxx', desc: '让 AI 记住某件事' },
    { cmd: '东雪莲忘记我', desc: '清空 AI 对你的记忆' },
    { cmd: '东雪莲清空群记忆', desc: '清空整个群的记忆' },
    { cmd: '东雪莲群记忆定时 <小时>', desc: '设置定时清空群记忆' },
  ]},
  { category: '集合与昵称', commands: [
    { cmd: '@A用户 昵称 名称A', desc: '为用户 A 设置昵称' },
    { cmd: '查看昵称 名称A / 谁是 名称A', desc: '查看昵称对应的用户' },
    { cmd: '查看成员 @A用户', desc: '查看用户的集合成员' },
    { cmd: '创建集合 集合A @A @B', desc: '创建集合' },
    { cmd: '集合添加 / 删除', desc: '管理集合成员' },
    { cmd: '复制集合 / 合并集合', desc: '集合操作' },
    { cmd: '集合交集 / 并集 / 差集', desc: '集合运算' },
  ]},
  { category: '群聊主动回复', commands: [
    { cmd: '概率查看 / 设置 / 重置', desc: '管理 AI 回复概率' },
    { cmd: '白名单添加 / 删除 / 查看', desc: '管理 AI 白名单' },
  ]},
  { category: '联网', commands: [
    { cmd: '东雪莲联网查看', desc: '查看联网搜索状态' },
    { cmd: '东雪莲联网开', desc: '开启联网搜索' },
    { cmd: '东雪莲联网关', desc: '关闭联网搜索' },
  ]},
  { category: '敏感话题检测', commands: [
    { cmd: '敏感话题检测开 / 关', desc: '开关敏感话题检测' },
    { cmd: '敏感话题处理者添加/删除', desc: '管理通知人' },
  ]},
  { category: '白名单黑名单', commands: [
    { cmd: '用户黑名单', desc: '管理用户黑名单' },
    { cmd: '解除上限群白名单', desc: '管理解除上限群白名单' },
    { cmd: '视频黑名单', desc: '管理视频黑名单' },
  ]},
]

exports.name = 'dashboard'
exports.FEATURES_DATA = FEATURES_DATA
exports.COMMANDS_DATA = COMMANDS_DATA
