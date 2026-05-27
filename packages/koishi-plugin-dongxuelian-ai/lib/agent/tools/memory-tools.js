"use strict";
const memory = require('../memory');
const { getAgentConfig } = require('../config');
function getUserId(context = {}) {
    return String(context.userId || 'dashboard');
}
function checkMemoryAccess(context = {}) {
    const cfg = getAgentConfig().memory || {};
    if (cfg.enabled === false)
        return '记忆功能当前未开启。';
    if (cfg.adminOnly && context.channel !== 'dashboard' && !context.isAdmin)
        return '记忆功能仅管理员可用。';
    return null;
}
const rememberMemoryTool = {
    definition: {
        name: 'remember_memory',
        description: '为当前用户显式写入一条长期记忆。',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '要记住的内容' },
                tags: { type: 'array', items: { type: 'string' }, description: '标签' },
            },
            required: ['text'],
        },
    },
    async execute(params = {}, context = {}) {
        const denied = checkMemoryAccess(context);
        if (denied)
            return denied;
        const item = await memory.remember({ userId: getUserId(context), channelKey: context.channelKey, text: params.text, tags: params.tags });
        return `已记住：${item.id}`;
    },
    dangerous: true,
    defaultChannels: ['dashboard'],
};
const searchMemoryTool = {
    definition: {
        name: 'search_memory',
        description: '搜索当前用户的长期记忆。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string' },
                limit: { type: 'number' },
            },
        },
    },
    async execute(params = {}, context = {}) {
        const denied = checkMemoryAccess(context);
        if (denied)
            return denied;
        const channel = context.channel || 'qq';
        if (channel === 'dashboard') {
            const dashResult = await memory.searchDashboardMemory({ userId: getUserId(context), query: params.query });
            if (dashResult)
                return dashResult;
            return '没有找到相关记忆。';
        }
        const items = await memory.searchMemory({ userId: getUserId(context), channelKey: context.channelKey, query: params.query, limit: params.limit });
        return memory.formatMemoryItems(items);
    },
    dangerous: true,
    defaultChannels: ['dashboard'],
};
const forgetMemoryTool = {
    definition: {
        name: 'forget_memory',
        description: '删除当前用户的一条长期记忆。',
        parameters: {
            type: 'object',
            properties: { memoryId: { type: 'string' } },
            required: ['memoryId'],
        },
    },
    async execute(params = {}, context = {}) {
        const denied = checkMemoryAccess(context);
        if (denied)
            return denied;
        const removed = await memory.forgetMemory({ userId: getUserId(context), memoryId: params.memoryId });
        return removed ? `已删除记忆：${params.memoryId}` : '没有找到这条记忆。';
    },
    dangerous: true,
    defaultChannels: ['dashboard'],
};
const listMemoryTool = {
    definition: {
        name: 'list_memory',
        description: '列出当前用户最近的长期记忆。',
        parameters: {
            type: 'object',
            properties: { limit: { type: 'number' } },
        },
    },
    async execute(params = {}, context = {}) {
        const denied = checkMemoryAccess(context);
        if (denied)
            return denied;
        const items = await memory.listMemory({ userId: getUserId(context), limit: params.limit });
        return memory.formatMemoryItems(items);
    },
    dangerous: false,
    defaultChannels: ['dashboard'],
};
module.exports = {
    rememberMemoryTool,
    searchMemoryTool,
    forgetMemoryTool,
    listMemoryTool,
    tools: [rememberMemoryTool, searchMemoryTool, forgetMemoryTool, listMemoryTool],
};
