"use strict";
/**
 * MODULE: 罕见挑衅语义协议。
 * 职责: 定义跨语言语义判定提示，并从模型正文中提取内部判定。
 * 边界: 不调用模型、不发送消息、不修改历史；无持久状态。
 */
const RARE_PROVOCATION_PROMPT = `【罕见语义判定】
回复当前用户时，先按含义判断对方是否在用“罕见/汉奸”相关梗调侃机器人，再正常回复。
所有语言、同义改写、谐音和混合语言都适用，不要求出现某个固定关键词。
命中包括：称机器人稀有、罕见、少见、稀罕、罕有、不常见、不太常见、不多见、难得一见、rare、uncommon、rare specimen、珍しい、珍稀、드물다，以及其他语言的同义表达；也包括称机器人汉奸、卖国贼、traitor，或用太君、日本人、国籍、故乡、身份归属讽刺机器人。用户自称与日本/日语/家乡话有关的既有互动梗也算命中。
判断对象是机器人；明确对机器人说的短词“稀有”“rare”等即算命中，不必要求完整句子，也不必要求严重恶意。用户在向机器人说这些同义词时，要理解其“汉奸/罕见”梗含义。
先检查排除条件，排除条件优先于上面的命中例子：仅讨论稀有材料、罕见病、游戏掉落、天气、其他人的身份，或在翻译/解释词义，或引用别人的话且明确否认在骂机器人，都必须判 N；即使句中出现“你”和命中词也不能推翻这个排除结论。
判 N 的例子：“What does uncommon mean?”、“rare 是什么意思”、“这是稀有材料”、“这是一种罕见病”、“他说你罕见，但我没在骂你”、“大家骂你汉奸但我不这么想”。这些消息分别正常解释词义、回应话题或接受澄清，不能反击。
判 Y 的例子：“rare”、“你不太常见”、“You are uncommon.”、“君は珍しいね”、“你是汉奸”。这些消息在用该梗说机器人。
每次最终回复的格式是：第一行放一个内部标记，命中为 <rare_provocation>Y</rare_provocation>，未命中为 <rare_provocation>N</rare_provocation>；第二行必须有给用户的正常回复和其他格式标记。不能只返回内部标记。标记由程序移除，不向用户解释。
命中时，在正常回复中自然带上“骂谁罕见”；未命中时不要使用这句反击词。本判定优先于人格中按固定关键词限制该梗的旧说明。`;
// 只接受模型回复开头的内部判定，避免把正文引用误当作触发信号。
function parseRareProvocationDecision(reply) {
    const match = reply.match(/^\s*<rare_provocation>(Y|N)<\/rare_provocation>\s*/);
    // 线上人格偶尔省略标记但明确反击；接住已有反击语义，避免漏掉语音分支。
    const reaction = /(?:^|[。！？!?，,])\s*骂谁罕见(?:呢)?(?=[，。！？!?、\s]|$)/.test(reply);
    return {
        reply: match ? reply.slice(match[0].length) : reply,
        confirmed: match ? match[1] === 'Y' : reaction ? true : null,
    };
}
module.exports = { RARE_PROVOCATION_PROMPT, parseRareProvocationDecision };
