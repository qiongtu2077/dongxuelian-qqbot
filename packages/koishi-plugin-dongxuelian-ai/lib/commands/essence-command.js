"use strict";
/** 群精华排行榜：按消息作者统计当前群精华，在一条合并转发中展示全部排名。 */
const { handled } = require('./command-result');
const inFlight = new Set();
// --- 统计与展示 ---
// 按 QQ 号聚合作者，同名群友分别统计，重复返回的同一条精华只计一次。
function rankEssenceMessages(messages) {
    const members = new Map();
    const seen = new Set();
    for (const message of messages) {
        const key = `${message.msg_seq}:${message.msg_random}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        const userId = String(message.sender_id);
        const member = members.get(userId);
        if (member)
            member.count += 1;
        else
            members.set(userId, {
                userId,
                nickname: message.sender_nick.replace(/\s+/g, ' ').trim() || `QQ ${userId}`,
                count: 1,
            });
    }
    return [...members.values()].sort((a, b) => b.count - a.count || Number(a.userId) - Number(b.userId));
}
// --- 命令执行 ---
// 复用 OneBot 连接读取全量精华并发送一次合并转发；失败时明确提示，不发送残缺榜单。
async function handleEssenceCommand(session, ctx) {
    if (session.isDirect || !session.guildId)
        return handled('这个命令只能在群里用。');
    const internal = session.bot?.internal;
    if (!internal?.getEssenceMsgList || !internal.sendGroupForwardMsg) {
        return handled('当前连接不支持获取群精华或发送合并转发。');
    }
    const groupId = session.guildId;
    const botId = String(session.selfId || session.bot?.selfId || '');
    const taskKey = `${botId}:${groupId}`;
    if (inFlight.has(taskKey))
        return handled('本群正在统计群精华，请稍候。');
    inFlight.add(taskKey);
    let stage = '获取群精华';
    try {
        // NapCat 的 get_essence_msg_list 内部遍历精华分页；无需自行猜测分页参数。
        const messages = await internal.getEssenceMsgList(groupId);
        const ranking = rankEssenceMessages(messages);
        const total = ranking.reduce((sum, member) => sum + member.count, 0);
        const contents = [`群精华排行榜\n共 ${total} 条精华，${ranking.length} 位群友\n按精华数量降序排列`];
        if (!ranking.length)
            contents.push('本群暂无群精华。');
        // 每个节点放 20 行，所有节点仍在同一条消息记录中，不截断低排名成员。
        for (let offset = 0; offset < ranking.length; offset += 20) {
            contents.push(ranking.slice(offset, offset + 20).map((member, index) => `${offset + index + 1}. ${member.nickname}（${member.userId}）：${member.count} 条`).join('\n'));
        }
        // 已核对线上 NapCat 的上游实现最多读取 20 × 50 条，达到边界时不能声称完整。
        if (messages.length >= 1000)
            contents.push('提示：精华接口已达到 1000 条读取上限，以上仅统计接口返回的精华。');
        const nodes = contents.map(text => ({
            type: 'node',
            data: { name: '东雪莲', uin: botId, content: [{ type: 'text', data: { text } }] },
        }));
        stage = '发送群精华排行榜';
        // 保留方法接收者，适配器依赖 this；文本消息段避免昵称被解析为 CQ 码。
        await internal.sendGroupForwardMsg(groupId, nodes);
        return handled();
    }
    catch (error) {
        ctx.logger('dongxuelian-ai').warn(`${stage}失败: ${error instanceof Error ? error.message : String(error)}`);
        return handled(`${stage}失败，请稍后重试。`);
    }
    finally {
        inFlight.delete(taskKey);
    }
}
module.exports = { handleEssenceCommand, rankEssenceMessages };
