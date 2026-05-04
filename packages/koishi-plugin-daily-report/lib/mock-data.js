/**
 * MODULE: 测试数据生成器。
 * 本地没有今日缓存时，生成模拟数据用于测试。
 */

function generateMockData(channelKey) {
  const today = new Date().toISOString().slice(0, 10)

  const mockMessages = [
    { time: '08:30:15', user: 'qiany024', userId: '10001', content: '早上好啊各位' },
    { time: '08:31:22', user: '若叶睦', userId: '10002', content: '早' },
    { time: '08:35:11', user: '圣中之月', userId: '10003', content: '今天有啥安排吗' },
    { time: '08:40:45', user: 'qiany024', userId: '10001', content: '等新版本更新吧，怪物猎人的' },
    { time: '08:42:03', user: '幻海潮汐', userId: '10004', content: '新武器平衡怎么样' },
    { time: '08:45:18', user: 'qiany024', userId: '10001', content: '太刀加强了，大剑还是那样' },
    { time: '08:46:00', user: '铃', userId: '10005', content: '大剑党哭泣' },
    { time: '08:50:22', user: '是可爱的阿米娅喵~', userId: '10006', content: '我倒是很期待新地图' },
    { time: '08:55:15', user: 'qiany024', userId: '10001', content: '新地图据说很大，跑图要半天' },
    { time: '08:57:33', user: '若叶睦', userId: '10002', content: '跑图不是问题，关键是有没有快速旅行' },
    { time: '09:05:11', user: '圣中之月', userId: '10003', content: '说到这个，明日方舟新活动你们玩了吗' },
    { time: '09:06:30', user: '幻海潮汐', userId: '10004', content: '玩了，这次关卡设计挺有意思的' },
    { time: '09:10:45', user: '铃', userId: '10005', content: '新干员强度如何' },
    { time: '09:12:18', user: '是可爱的阿米娅喵~', userId: '10006', content: '六星感觉一般般，五星反而更实用' },
    { time: '09:15:33', user: 'qiany024', userId: '10001', content: '对了，有人看了那个二游社区的争议吗' },
    { time: '09:16:45', user: '圣中之月', userId: '10003', content: '别提了，又是性别争议，烦死了' },
    { time: '09:18:02', user: '幻海潮汐', userId: '10004', content: '现在二游社区太乱了，什么都能吵起来' },
    { time: '09:20:15', user: '铃', userId: '10005', content: '建议别看那些，专心玩游戏就好' },
    { time: '09:22:33', user: 'qiany024', userId: '10001', content: '说得对，玩自己的就好' },
    { time: '09:25:00', user: '是可爱的阿米娅喵~', userId: '10006', content: '话说最近有没有什么好玩的新游戏推荐' },
    { time: '09:30:15', user: '若叶睦', userId: '10002', content: '黑神话悟空你们通关了吗' },
    { time: '09:31:30', user: 'qiany024', userId: '10001', content: '通关了，二周目打隐藏boss' },
    { time: '09:33:45', user: '圣中之月', userId: '10003', content: '那个boss太难了，我卡了两天' },
    { time: '09:35:11', user: '幻海潮汐', userId: '10004', content: '多练习闪避就好，节奏很重要' },
    { time: '09:38:22', user: '铃', userId: '10005', content: '我觉得最烦的是收集要素，跑图跑得头晕' },
    { time: '09:40:33', user: '是可爱的阿米娅喵~', userId: '10006', content: '收集党表示还好，慢慢来就行' },
    { time: '09:45:15', user: 'qiany024', userId: '10001', content: '对了你们玩原神吗，新版本出了' },
    { time: '09:46:30', user: '若叶睦', userId: '10002', content: '玩啊，新角色太强了' },
    { time: '09:48:45', user: '圣中之月', userId: '10003', content: '强度膨胀太快了，老角色都没人用' },
    { time: '09:50:11', user: '幻海潮汐', userId: '10004', content: '游戏平衡性一直都是问题' },
    { time: '09:55:22', user: '铃', userId: '10005', content: '原神肝度太高了，每天做日常累死了' },
    { time: '09:57:33', user: '是可爱的阿米娅喵~', userId: '10006', content: '佛系玩家表示无所谓，慢慢玩' },
    { time: '10:05:00', user: 'qiany024', userId: '10001', content: '中午了，有人一起吃饭吗' },
    { time: '10:06:15', user: '若叶睦', userId: '10002', content: '我要点外卖' },
    { time: '10:07:30', user: '圣中之月', userId: '10003', content: '食堂走起' },
    { time: '10:10:45', user: '幻海潮汐', userId: '10004', content: '下午继续聊，先去吃饭' },
    { time: '13:10:00', user: 'qiany024', userId: '10001', content: '回来了，下午继续' },
    { time: '13:12:15', user: '铃', userId: '10005', content: '午觉睡过头了' },
    { time: '13:15:30', user: '是可爱的阿米娅喵~', userId: '10006', content: '下午摸鱼时间到' },
    { time: '13:20:00', user: '圣中之月', userId: '10003', content: '有没有人一起打游戏' },
    { time: '13:22:15', user: '幻海潮汐', userId: '10004', content: '来来来，组队' },
    { time: '13:25:30', user: 'qiany024', userId: '10001', content: '等我一下，马上来' },
    { time: '13:30:00', user: '若叶睦', userId: '10002', content: '我也要加入' },
    { time: '13:35:15', user: '铃', userId: '10005', content: '今天打什么副本' },
    { time: '13:37:30', user: '圣中之月', userId: '10003', content: '刷装备啊，还差一个头盔' },
    { time: '13:40:45', user: '幻海潮汐', userId: '10004', content: '我装备够了，纯娱乐' },
    { time: '13:45:00', user: 'qiany024', userId: '10001', content: '你们有没有看今天的热搜' },
    { time: '13:46:15', user: '若叶睦', userId: '10002', content: '什么热搜' },
    { time: '13:47:30', user: 'qiany024', userId: '10001', content: '有个游戏公司暴雷了，程序员集体离职' },
    { time: '13:48:45', user: '圣中之月', userId: '10003', content: '又来？今年第几个了' },
    { time: '13:50:00', user: '幻海潮汐', userId: '10004', content: '游戏行业最近不太景气啊' },
    { time: '13:52:15', user: '铃', userId: '10005', content: '程序员太惨了，996还被裁' },
    { time: '13:55:30', user: '是可爱的阿米娅喵~', userId: '10006', content: '希望他们能找到好工作' },
    { time: '14:00:00', user: 'qiany024', userId: '10001', content: '话说你们有看那个新番吗' },
    { time: '14:02:15', user: '若叶睦', userId: '10002', content: '哪一部' },
    { time: '14:03:30', user: 'qiany024', userId: '10001', content: '就是那个异世界转生的，评分很高' },
    { time: '14:05:45', user: '圣中之月', userId: '10003', content: '异世界都看腻了，能不能换个题材' },
    { time: '14:08:00', user: '幻海潮汐', userId: '10004', content: '确实，异世界番太多了' },
    { time: '14:10:15', user: '铃', userId: '10005', content: '我推荐那个日常系的，很治愈' },
    { time: '14:12:30', user: '是可爱的阿米娅喵~', userId: '10006', content: '日常系好看！画面很美' },
    { time: '14:15:45', user: 'qiany024', userId: '10001', content: '好，我去看看' },
    { time: '14:20:00', user: '圣中之月', userId: '10003', content: '对了，你们有没有看今天的新闻' },
    { time: '14:22:15', user: '幻海潮汐', userId: '10004', content: '什么新闻' },
    { time: '14:23:30', user: '圣中之月', userId: '10003', content: '有个明星塌房了，具体不说了' },
    { time: '14:25:45', user: '铃', userId: '10005', content: '又塌？娱乐圈真热闹' },
    { time: '14:28:00', user: '是可爱的阿米娅喵~', userId: '10006', content: '吃瓜吃瓜' },
    { time: '14:30:15', user: 'qiany024', userId: '10001', content: '娱乐圈的事看看就好，别太认真' },
    { time: '14:35:30', user: '若叶睦', userId: '10002', content: '同意，还是游戏好玩' },
    { time: '14:40:45', user: '圣中之月', userId: '10003', content: '说到游戏，你们知道暴雪的新消息吗' },
    { time: '14:42:00', user: '幻海潮汐', userId: '10004', content: '什么消息' },
    { time: '14:43:15', user: '圣中之月', userId: '10003', content: '好像要出新资料片了' },
    { time: '14:45:30', user: 'qiany024', userId: '10001', content: '暴雪啊，又爱又恨' },
    { time: '14:48:45', user: '铃', userId: '10005', content: '暴雪的策划一直在挨骂' },
    { time: '14:50:00', user: '是可爱的阿米娅喵~', userId: '10006', content: '暴雪已死，暴雪万岁' },
    { time: '14:55:15', user: 'qiany024', userId: '10001', content: '经典梗' },
    { time: '15:00:30', user: '若叶睦', userId: '10002', content: '行了行了，继续打游戏吧' },
    { time: '15:05:45', user: '圣中之月', userId: '10003', content: '来来来，继续副本' },
    { time: '15:10:00', user: '幻海潮汐', userId: '10004', content: '今天效率不错啊' },
    { time: '15:15:15', user: '铃', userId: '10005', content: '装备终于齐了！' },
    { time: '15:20:30', user: '是可爱的阿米娅喵~', userId: '10006', content: '恭喜恭喜' },
    { time: '15:25:45', user: 'qiany024', userId: '10001', content: '今天玩得开心，明天继续' },
    { time: '15:30:00', user: '若叶睦', userId: '10002', content: '明天见' },
    { time: '15:35:15', user: '圣中之月', userId: '10003', content: '大家辛苦了' },
    { time: '15:40:30', user: '幻海潮汐', userId: '10004', content: '晚上还有人在线吗' },
    { time: '15:45:45', user: '铃', userId: '10005', content: '晚上再说吧' },
    { time: '15:50:00', user: '是可爱的阿米娅喵~', userId: '10006', content: '晚上我可能要加班' },
    { time: '15:55:15', user: 'qiany024', userId: '10001', content: '辛苦了，注意休息' },
  ]

  const totalMessages = mockMessages.length
  const memberSet = new Set(mockMessages.map(m => m.userId))
  const activeMembers = memberSet.size
  const emojiCount = 18
  const totalChars = mockMessages.reduce((sum, m) => sum + m.content.length, 0)

  const hourlyActivity = new Array(24).fill(0)
  for (const msg of mockMessages) {
    const hour = parseInt(msg.time.split(':')[0], 10)
    hourlyActivity[hour]++
  }

  let maxHour = 0, maxCount = 0
  for (let i = 0; i < 24; i++) {
    if (hourlyActivity[i] > maxCount) { maxCount = hourlyActivity[i]; maxHour = i }
  }

  const memberMap = new Map()
  for (const msg of mockMessages) {
    if (!memberMap.has(msg.userId)) {
      memberMap.set(msg.userId, { userId: msg.userId, name: msg.user, msgCount: 0 })
    }
    memberMap.get(msg.userId).msgCount++
  }
  const topMembers = [...memberMap.values()].sort((a, b) => b.msgCount - a.msgCount)

  return {
    date: today, totalMessages, activeMembers, emojiCount, totalChars,
    hourlyActivity,
    peakHour: `${String(maxHour).padStart(2,'0')}:00-${String(maxHour).padStart(2,'0')}:59`,
    topMembers, messages: mockMessages,
  }
}

function generateMockAnalysis(data) {
  const names = data.topMembers.map(m => m.name)
  return {
    topics: [
      { id: 1, title: '怪物猎人新版本讨论', summary: '讨论了新版本的武器平衡，太刀加强引发热议，大剑玩家表示羡慕。地图设计也备受期待，新区域据说非常大，跑图需要半天时间。讨论集中在怪物攻击模式和武器选择的影响。', participants: names.slice(0, 4) },
      { id: 2, title: '明日方舟新活动攻略', summary: '新关卡设计和干员强度分析，六星干员表现一般，反而是五星更实用引发讨论。讨论还涉及中坚池和自选干员的选择，形成了初步的抽卡规划。', participants: names.slice(2, 6) },
      { id: 3, title: '黑神话悟空通关心得', summary: '分享隐藏boss攻略和通关心得，收集要素让部分玩家头疼但乐在其中。讨论了boss的攻击节奏和闪避时机，还有装备搭配建议。', participants: names.slice(0, 3) },
      { id: 4, title: '原神新版本强度膨胀', summary: '讨论新角色强度过高导致老角色无人使用的问题。游戏平衡性一直是争议焦点，佛系玩家和强度党各执一词。', participants: names.slice(1, 5) },
      { id: 5, title: '游戏公司暴雷新闻', summary: '今天有游戏公司暴雷，程序员集体离职。大家讨论游戏行业不景气，程序员996还被裁的现状。', participants: names.slice(0, 6) },
      { id: 6, title: '新番推荐与讨论', summary: '讨论新番推荐，异世界转生题材评分高但大家表示看腻了，推荐日常系治愈番。还有明星塌房新闻和暴雪新资料片消息。', participants: names.slice(1, 6) },
    ],
    userTitles: names.slice(0, 6).map((name, i) => ({
      name,
      title: ['活跃水怪', '安静观察者', '游戏老司机', '理性分析者', '表情包大师', '二次元宅'][i],
      mbti: ['ENFP', 'ISTJ', 'ISTP', 'INTP', 'ENFP', 'INFP'][i],
      reason: [
        '发言最多，话题发起者，从游戏聊到新闻无所不谈',
        '发言少但质量高，一针见血，关键时刻出来总结',
        '各类游戏都玩，经验丰富，装备党本党',
        '喜欢分析机制，说话有条理，理性担当',
        '善用表情包，活跃气氛，情绪价值拉满',
        '明日方舟真爱粉，二次元浓度最高，发言可爱',
      ][i],
    })),
    goldenQuotes: [
      { sender: names[0], content: '太刀加强了，大剑还是那样', reason: '经典刀党言论，大剑玩家集体震怒' },
      { sender: names[1], content: '跑图不是问题，关键是有没有快速旅行', reason: '一针见血指出核心问题' },
      { sender: names[4], content: '建议别看那些，专心玩游戏就好', reason: '人间清醒，互联网冲浪哲学' },
      { sender: names[5], content: '暴雪已死，暴雪万岁', reason: '经典矛盾修辞，暴雪玩家的真实写照' },
      { sender: names[2], content: '又来？今年第几个了', reason: '游戏公司暴雷已经见怪不怪了' },
    ],
    qualityReview: {
      title: '[演示数据] 赛博搬砖工的一天：游戏、报错与调戏的完美平衡',
      subtitle: '白天肝攻略，晚上调戏AI，中间还要解决技术难题',
      dimensions: [
        { name: '游戏生态的昼夜交替', percentage: 35, comment: '从怪物猎人到黑神话，白天肝攻略晚上打boss，二刺猿们白天比谁攻略做得细，晚上比谁骂得狠', color: '#39C5BB' },
        { name: '技术修罗场的日常', percentage: 18, comment: '报错代码是今天的共同语言，从模拟器崩溃到工具链调优，群友一边骂娘一边甩出解决方案', color: '#A7E7E3' },
        { name: '赛博人格分裂修罗群', percentage: 22, comment: '白天是理性的技术大佬，入夜就集体变身赛博巨婴，对AI狂飙脏话', color: '#F8BBD0' },
        { name: '圈层记忆与身份认同', percentage: 15, comment: '怀旧感与圈层战争交织，老玩家靠怪物猎人联动忆青春，新玩家在玻璃和打嘴炮中寻找归属', color: '#fff9c4' },
        { name: '新闻八卦茶话会', percentage: 10, comment: '游戏公司暴雷、明星塌房、暴雪新消息，信息量巨大但大家一致表示吃瓜就好', color: '#e0f2f1' },
      ],
      summary: '今天也是从技术大佬到赛博巨婴无缝切换的一天，游戏、报错、调戏三件套，拼凑出当代年轻人最真实的精神状态：一边崩溃，一边狂欢，一边期待明天。群里从怪物猎人聊到暴雪暴雷，中间穿插二游社区吐槽和明星塌房，信息量巨大但不失趣味。',
    },
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  }
}

module.exports = { generateMockData, generateMockAnalysis }
