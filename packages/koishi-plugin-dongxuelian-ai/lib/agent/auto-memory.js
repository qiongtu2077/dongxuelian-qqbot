"use strict";
/**
 * MODULE: Agent automatic memory trigger.
 * Responsibility: decide when dashboard Agent replies should enqueue background memory extraction.
 * Boundary: does not call LLM and does not write memory files; S2 memory-worker owns execution.
 */
const { getAgentConfig } = require('./config');
const { DASHBOARD_MEMORY_DIR, DAILY_DIR, AUTO_MEMORY_INTERVAL, submitAgentMemoryTask, getDailyTotalSize, safeUserId, } = require('../resource-workers/memory-worker');
const AUTO_MEMORY_WINDOW = 8;
const userMessageCounters = new Map();
// Return true for message records that can be serialized into a memory task.
function isAutoMemoryMessage(value) {
    if (!value || typeof value !== 'object')
        return false;
    const role = value.role;
    return role === 'user' || role === 'assistant';
}
// Build a stable counter key for dashboard auto-memory triggers.
function getCounterKey(userId) {
    return `dashboard:${safeUserId(String(userId || ''))}`;
}
// Increment and cap the in-process trigger counter map.
function incrementCounter(userId) {
    const key = getCounterKey(userId);
    const count = (userMessageCounters.get(key) || 0) + 1;
    if (userMessageCounters.size > 5000) {
        const first = userMessageCounters.keys().next().value;
        if (first !== undefined)
            userMessageCounters.delete(first);
    }
    userMessageCounters.set(key, count);
    return count;
}
// Return true when this reply should enqueue a memory extraction task.
function shouldTrigger(userId) {
    const count = incrementCounter(userId);
    return count % AUTO_MEMORY_INTERVAL === 0;
}
// Enqueue background memory extraction after a dashboard Agent reply.
async function onAgentReplyComplete({ userId, channel, messages } = {}) {
    if (channel !== 'dashboard')
        return;
    if (getAgentConfig().memory?.enabled === false)
        return;
    if (!shouldTrigger(userId))
        return;
    const recentMessages = (Array.isArray(messages) ? messages : [])
        .filter(isAutoMemoryMessage)
        .slice(-AUTO_MEMORY_WINDOW * 2);
    if (recentMessages.length < 2)
        return;
    try {
        submitAgentMemoryTask({
            userId,
            recentMessages,
            source: 'agent-auto-memory',
        });
    }
    catch {
        // Automatic memory must never affect the user-visible Agent reply.
    }
}
// Reset one user's trigger counter.
function resetAutoMemoryCounter(userId) {
    const key = getCounterKey(userId);
    userMessageCounters.delete(key);
}
// Return lightweight auto-memory stats for diagnostics.
function getAutoMemoryStats() {
    return {
        counters: Object.fromEntries(userMessageCounters),
        interval: AUTO_MEMORY_INTERVAL,
        memoryDir: DASHBOARD_MEMORY_DIR,
    };
}
module.exports = {
    DASHBOARD_MEMORY_DIR,
    DAILY_DIR,
    onAgentReplyComplete,
    resetAutoMemoryCounter,
    getAutoMemoryStats,
    shouldTrigger,
    getDailyTotalSize,
    safeUserId,
};
