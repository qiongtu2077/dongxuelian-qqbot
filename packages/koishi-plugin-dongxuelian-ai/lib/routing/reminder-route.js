"use strict";
/**
 * MODULE: 提醒请求兜底解析。
 * 职责: 在模型漏调提醒工具时，从明确短句中提取创建/查看/取消参数。
 * 边界: 不调度任务、不发消息；真正执行由现有 cron 提醒工具完成。
 */
const RELATIVE_UNITS_MS = {
    秒: 1000,
    分钟: 60 * 1000,
    分: 60 * 1000,
    小时: 60 * 60 * 1000,
    钟头: 60 * 60 * 1000,
    天: 24 * 60 * 60 * 1000,
};
const CHINESE_NUMBERS = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
function parseChineseInteger(text = '') {
    const value = String(text || '').trim();
    if (!value)
        return 0;
    if (/^\d+(?:\.\d+)?$/.test(value))
        return Number(value);
    if (value === '十')
        return 10;
    const tenIndex = value.indexOf('十');
    if (tenIndex >= 0) {
        const left = value.slice(0, tenIndex);
        const right = value.slice(tenIndex + 1);
        const tens = left ? (CHINESE_NUMBERS[left] || 0) : 1;
        const ones = right ? (CHINESE_NUMBERS[right] || 0) : 0;
        return tens * 10 + ones;
    }
    return CHINESE_NUMBERS[value] || 0;
}
function stripReminderNoise(text = '') {
    return String(text || '')
        .replace(/^说错了[，,、\s]*/, '')
        .replace(/^(?:麻烦|帮我|记得|到时候|等会儿|等下)[，,、\s]*/, '')
        .replace(/[。.!！~～\s]+$/g, '')
        .trim();
}
function parseReminderRequest(text = '', now = Date.now()) {
    const value = stripReminderNoise(text);
    if (!value || !/(提醒|叫我|喊我|闹钟)/.test(value))
        return null;
    const relative = value.match(/([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,4})\s*(秒|分钟|分|小时|钟头|天)后/);
    if (!relative)
        return null;
    const amount = parseChineseInteger(relative[1]);
    const unitMs = RELATIVE_UNITS_MS[relative[2]];
    if (!amount || !unitMs)
        return null;
    const delayMs = amount * unitMs;
    if (!Number.isFinite(delayMs) || delayMs <= 0)
        return null;
    let reminderText = value
        .replace(relative[0], '')
        .replace(/^(?:提醒|叫|喊|闹钟)(?:我)?[，,、\s]*/, '')
        .replace(/^(?:我)?(?:提醒|叫|喊)[，,、\s]*/, '')
        .replace(/^(?:提醒我|叫我|喊我|设个闹钟|定个闹钟)[，,、\s]*/, '')
        .trim();
    if (!reminderText)
        reminderText = '时间到了';
    return {
        runAt: now + delayMs,
        delayMinutes: delayMs / (60 * 1000),
        text: reminderText.slice(0, 200),
    };
}
function parseReminderListRequest(text = '') {
    const value = stripReminderNoise(text);
    if (!value || !/(提醒|闹钟)/.test(value))
        return null;
    if (!/(查看|查一下|看看|列出|列表|还有|哪些|有什么|多少|待触发)/.test(value))
        return null;
    return { limit: 10 };
}
function parseReminderCancelRequest(text = '') {
    const value = stripReminderNoise(text);
    if (!value || !/(提醒|闹钟|叫我|喊我)/.test(value))
        return null;
    if (!/(取消|删除|删掉|撤销|不用|别提醒|别叫|别喊|关掉)/.test(value))
        return null;
    const latest = /(刚才|最近|上一条|上一个|最后|最新|那条|这条)/.test(value);
    const keyword = value
        .replace(/^(?:麻烦|帮我|请|把|给我|能不能)[，,、\s]*/g, '')
        .replace(/(取消|删除|删掉|撤销|不用|别提醒|别叫|别喊|关掉|提醒|闹钟|叫我|喊我|刚才|最近|上一条|上一个|最后|最新|那条|这条|一下|吧|了)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    const result = {};
    if (latest)
        result.latest = true;
    if (keyword)
        result.keyword = keyword;
    return result;
}
function parseReminderActionRequest(text = '', now = Date.now()) {
    const cancel = parseReminderCancelRequest(text);
    if (cancel)
        return { name: 'cancel_reminder', args: cancel };
    const list = parseReminderListRequest(text);
    if (list)
        return { name: 'list_reminders', args: list };
    const create = parseReminderRequest(text, now);
    if (create)
        return { name: 'create_reminder', args: create };
    return null;
}
function isReminderToolName(name = '') {
    return ['create_reminder', 'list_reminders', 'cancel_reminder', 'create_scheduled_task', 'list_scheduled_tasks', 'get_scheduled_task', 'pause_scheduled_task', 'resume_scheduled_task', 'delete_scheduled_task', 'run_scheduled_task_now'].includes(String(name || ''));
}
function parseDailyTime(text = '') {
    const value = String(text || '');
    const match = value.match(/(?:每天|每日).{0,8}?(早上|上午|中午|下午|晚上|夜里|凌晨)?\s*([0-9]{1,2}|[零一二两三四五六七八九十]{1,3})(?:点|:|：)(?:\s*([0-9]{1,2}|[零一二两三四五六七八九十]{1,3})\s*分?)?/);
    if (!match)
        return null;
    let hour = parseChineseInteger(match[2]);
    const minute = match[3] ? parseChineseInteger(match[3]) : 0;
    const dayPart = match[1] || '';
    if ((dayPart === '下午' || dayPart === '晚上' || dayPart === '夜里') && hour >= 1 && hour < 12)
        hour += 12;
    if (dayPart === '凌晨' && hour === 12)
        hour = 0;
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59)
        return null;
    return { hour, minute, schedule: `${minute} ${hour} * * *`, scheduleText: `每天 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}
function parseScheduledTaskRequest(text = '') {
    const value = stripReminderNoise(text);
    if (!value || !/(定时|任务|每天|每日|每周|每隔|周期|早安|总结|分析|提醒|叫我|喊我)/.test(value))
        return null;
    const daily = parseDailyTime(value);
    if (!daily)
        return null;
    const type = /(总结|分析|搜索|检查|看看|读|文件|文档|群聊|日报|周报)/.test(value) ? 'agent' : 'text';
    let prompt = value
        .replace(/^(?:麻烦|帮我|请|记得|到时候)[，,、\s]*/g, '')
        .replace(/(?:每天|每日).{0,16}?(?:[0-9]{1,2}|[零一二两三四五六七八九十]{1,3})(?:点|:|：)(?:\s*(?:[0-9]{1,2}|[零一二两三四五六七八九十]{1,3})\s*分?)?/g, '')
        .replace(/^(?:跟我|给我|对我|在群里|到时候)[，,、\s]*/g, '')
        .trim();
    if (!prompt)
        prompt = type === 'text' ? '早安' : value;
    return {
        name: 'create_scheduled_task',
        args: {
            mode: 'cron',
            type,
            schedule: daily.schedule,
            scheduleText: daily.scheduleText,
            title: prompt.slice(0, 80),
            prompt: prompt.slice(0, 500),
        },
    };
}
function isReminderCapabilityRefusal(reply = '') {
    const text = String(reply || '');
    if (!text)
        return false;
    if (!/(提醒|闹钟|定时|到点|叫你|叫我)/.test(text))
        return false;
    return /(?:做不到|不能|没法|无法|不会|不是.{0,8}(?:闹钟|助手)|不支持|干不来)/.test(text);
}
function isReminderUnbackedPromise(reply = '', userText = '') {
    const text = String(reply || '');
    const user = String(userText || '');
    if (!text || !parseReminderRequest(user))
        return false;
    if (/已创建提醒|提醒已创建/.test(text))
        return false;
    return /(?:会提醒你|我会提醒|帮你记住|记住了|叫你|喊你|到时候提醒|一分钟后|十分钟后|睡个好觉)/.test(text);
}
module.exports = {
    parseReminderRequest,
    parseReminderListRequest,
    parseReminderCancelRequest,
    parseReminderActionRequest,
    parseScheduledTaskRequest,
    isReminderToolName,
    isReminderCapabilityRefusal,
    isReminderUnbackedPromise,
};
