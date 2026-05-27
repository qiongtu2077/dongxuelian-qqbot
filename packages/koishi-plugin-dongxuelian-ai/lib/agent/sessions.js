"use strict";
const sessions = new Map();
const MAX_SESSIONS = 100;
const MAX_TURNS_PER_SESSION = 20;
function normalizeSessionPart(item) {
    return String(item || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80);
}
function buildAgentSessionId(channelKey, userId, channel = 'unknown') {
    return [channel, channelKey, userId].map(normalizeSessionPart).join(':');
}
function trimAgentSessions() {
    while (sessions.size > MAX_SESSIONS) {
        const oldestId = sessions.keys().next().value;
        if (!oldestId)
            break;
        sessions.delete(oldestId);
    }
}
function recordAgentSession({ channel = 'unknown', channelKey = 'unknown', userId = 'unknown', userName = '用户', userMessage = '', reply = '', toolCalls = 0, pendingId = null } = {}) {
    const id = buildAgentSessionId(channelKey, userId, channel);
    const now = Date.now();
    const current = sessions.get(id) || {
        id,
        channel,
        channelKey,
        userId,
        userName,
        title: String(userMessage || 'Agent 会话').slice(0, 40) || 'Agent 会话',
        createdAt: now,
        updatedAt: now,
        turns: [],
        toolCalls: 0,
    };
    current.channel = channel;
    current.channelKey = channelKey;
    current.userId = userId;
    current.userName = userName || current.userName;
    current.updatedAt = now;
    current.toolCalls += Number(toolCalls) || 0;
    current.pendingId = pendingId || null;
    current.lastMessage = String(userMessage || '').slice(0, 160);
    current.lastReply = String(reply || '').slice(0, 160);
    current.turns.unshift({ at: now, userMessage: current.lastMessage, reply: current.lastReply, toolCalls: Number(toolCalls) || 0, pendingId: current.pendingId });
    if (current.turns.length > MAX_TURNS_PER_SESSION)
        current.turns.length = MAX_TURNS_PER_SESSION;
    if (sessions.has(id))
        sessions.delete(id);
    sessions.set(id, current);
    trimAgentSessions();
    return id;
}
function listAgentSessions() {
    return Array.from(sessions.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(session => ({
        id: session.id,
        channel: session.channel,
        channelKey: session.channelKey,
        userId: session.userId,
        userName: session.userName,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        turns: session.turns.length,
        toolCalls: session.toolCalls,
        pendingId: session.pendingId || null,
        lastMessage: session.lastMessage || '',
        lastReply: session.lastReply || '',
    }));
}
function getAgentSession(id) {
    const session = sessions.get(String(id || ''));
    if (!session)
        return null;
    return { ...session, turns: session.turns.slice() };
}
function clearAgentSessions() {
    sessions.clear();
}
module.exports = { buildAgentSessionId, recordAgentSession, listAgentSessions, getAgentSession, clearAgentSessions };
