# affect-router 情绪输出路由详细设计

## 状态

暂缓实现。先完成 `PersonaRuntimePlan`、TTS 从 plan 读取、随机语音概率稳定、prompt 诊断和表达/profile 基础后，再进入本设计。

## 核心目标

`affect-router` 统一决定本轮输出形式：纯文本、文本加语音、文本加表情、纯语音或沉默。它不是表情开关，也不是随机语音替代品，而是防止文本、语音、表情三套表达互相打架。

## 最大风险：情绪输出导致 OOC

如果只按情绪标签发语音或表情，容易出现：

- 文本是沉稳人格，语音提示词却活泼可爱。
- 严肃拒绝时发轻浮表情。
- 用户低落时玩梗。
- 群聊随机语音绕过人格 voice_style 和冷却。

所以优先级必须是：

```text
安全风险 > 用户情绪 > 人格风格 > 概率/冷却 > 可用资源
```

## 输出结构

```js
{
  mood: 'tease' | 'comfort' | 'serious' | 'refuse' | 'angry' | 'confused' | 'playful',
  outputMode: 'text' | 'text_voice' | 'text_emoji' | 'voice_only' | 'silent',
  voiceStylePatch: '',
  emojiQuery: { tags: [], maxRisk: 'safe' },
  blockers: [],
  reasons: []
}
```

## 输入

- `PersonaRuntimePlan`
- 回复文本
- 用户消息风险分类
- 当前场景：私聊、群聊、显式 @、随机回复、Agent 转述
- TTS voice asset 状态
- 随机语音概率和冷却
- 表情库审核状态
- 人格 affect policy

## 人格情绪策略

plan 中需要声明：

```js
{
  affectPolicy: {
    allowVoice: true,
    allowEmoji: false,
    allowVoiceOnly: false,
    maxPlayfulStrength: 0.2,
    blockedMoods: ['meme_spam'],
    seriousMode: 'text_only'
  }
}
```

强人格默认保守：

- 长离：允许克制语音，不允许轻浮表情。
- 特蕾西娅：语音可柔和，但低频；严肃和安慰优先纯文本。
- 爱弥斯：允许理性语音，禁卖萌表情。
- 东雪莲：可更灵活，但敏感/拒绝/低落场景仍禁玩梗。

## 硬规则

- 敏感、拒绝、隐私、政治、安全边界：强制纯文本。
- 用户低落、求安慰：禁嘲讽、禁玩梗表情、禁轻浮语音。
- Agent 工具失败或不确定：纯文本解释，禁表情。
- TTS asset 缺失：回退纯文本或默认音色。
- 未审核表情资源：不可发送。
- 随机语音仍受原概率和冷却控制，affect-router 只能降级，不能绕过概率强制发送。

## 分阶段接入

1. 旁路诊断：只输出 reasons，不改变发送。
2. TTS style patch：只微调语音风格，不改变是否发语音。
3. 语音降级：在敏感/严肃/低落场景阻止不合适语音。
4. 表情诊断：只推荐表情标签，不发送。
5. 人工审核表情发送：小范围灰度，带频控和回退。

## 测试故事

- 敏感拒绝场景强制纯文本。
- 用户低落时不发表情、不用调侃语音。
- 长离人格不会被 patch 成活泼可爱。
- TTS asset 缺失时回退，不影响文本回复。
- 随机语音概率为 0 时 affect-router 不能强制发语音。
- 未审核表情永远不发送。
- affect-router 失败时纯文本回复。
