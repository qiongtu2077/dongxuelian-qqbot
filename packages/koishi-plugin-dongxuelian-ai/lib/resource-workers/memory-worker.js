"use strict";
/**
 * MODULE: S2 memory-worker executor.
 * Responsibility: run dashboard Agent auto-memory extraction and Dream compaction in an isolated worker.
 * Boundary: no QQ/Dashboard sending; Koishi main process should only submit S2 memory tasks.
 */
const fsp = require('fs/promises');
const path = require('path');
const { DATA_DIR } = require('../core/constants');
const { requestChatCompletions } = require('../core/api');
const { loadConfig } = require('../core/runtime-config');
const { safeUserId, legacySafeUserId } = require('../core/utils');
const { submitWorkerTaskWithAdmission } = require('./task-client');
const { listResourceTasks } = require('./task-store');
const DASHBOARD_MEMORY_DIR = path.join(DATA_DIR, 'agent-memory-dashboard');
const DAILY_DIR = path.join(DASHBOARD_MEMORY_DIR, 'daily');
const AUTO_MEMORY_INTERVAL = 8;
const AUTO_MEMORY_WINDOW = 8;
const MAX_CHARS_PER_TURN = 500;
const MAX_DAILY_FILE_BYTES = 50 * 1024;
const DREAM_SIZE_THRESHOLD = 20 * 1024;
const MAX_LONG_TERM_FILE_BYTES = 100 * 1024;
const EXTRACT_PROMPT = [
    'Extract durable long-term memories from the dialogue below.',
    'Only keep explicit user preferences, identity facts, stable habits, important facts, decisions, agreements, and workflow preferences.',
    'Do not keep temporary topics, small talk, obvious facts, or tool-call details.',
    'Output one concise memory per line in the user language. If nothing is worth remembering, output an empty response.',
].join('\n');
const DREAM_PROMPT = [
    'You are a memory consolidation assistant.',
    'Merge daily memory notes into a compact long-term memory file.',
    'Keep only durable preferences, confirmed facts, high-value experience, and current decisions.',
    'Newer facts override older facts. Merge duplicates. Remove outdated or low-value notes.',
    'Output plain text, one memory per line. Do not output JSON.',
].join('\n');
// Return a bounded future ISO timestamp for background task expiry.
function getExpiryIso(ttlMs) {
    return new Date(Date.now() + Math.max(1000, Number(ttlMs) || 1000)).toISOString();
}
// Normalize serialized recent messages before they enter an LLM prompt.
function normalizeRecentMessages(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .filter(item => item && typeof item === 'object')
        .map(item => {
        const record = item;
        const role = record.role === 'assistant' ? 'assistant' : record.role === 'user' ? 'user' : '';
        const content = String(record.content || '').slice(0, MAX_CHARS_PER_TURN);
        return role && content ? { role, content } : null;
    })
        .filter(Boolean)
        .slice(-AUTO_MEMORY_WINDOW * 2);
}
// Build the daily memory file path for a user and date.
function getDailyFile(userId, date = new Date().toISOString().slice(0, 10)) {
    return path.join(DAILY_DIR, `${safeUserId(String(userId || ''))}.${date}.md`);
}
// Build the long-term memory file path for a user.
function getLongTermFile(userId) {
    return path.join(DASHBOARD_MEMORY_DIR, `${safeUserId(String(userId || ''))}.md`);
}
// Build the long-term memory backup file path for a user.
function getBackupFile(userId) {
    return path.join(DASHBOARD_MEMORY_DIR, `${safeUserId(String(userId || ''))}.md.bak`);
}
// Return current and legacy long-term memory file candidates.
function getLongTermFileCandidates(userId) {
    const current = safeUserId(String(userId || ''));
    const legacy = legacySafeUserId(String(userId || ''));
    const files = [path.join(DASHBOARD_MEMORY_DIR, `${current}.md`)];
    if (legacy !== current)
        files.push(path.join(DASHBOARD_MEMORY_DIR, `${legacy}.md`));
    return files;
}
// Read the current daily memory file when it is small enough to use as duplicate context.
async function readDailyFile(userId) {
    try {
        const file = getDailyFile(userId);
        const stat = await fsp.stat(file);
        if (!stat.isFile() || stat.size > MAX_DAILY_FILE_BYTES)
            return '';
        return await fsp.readFile(file, 'utf8');
    }
    catch {
        return '';
    }
}
// Append extracted memory text to today's daily memory file.
async function appendDailyFile(userId, content) {
    await fsp.mkdir(DAILY_DIR, { recursive: true });
    const file = getDailyFile(userId);
    const timestamp = new Date().toISOString().slice(11, 16);
    const entry = `[${timestamp}] ${content.trim()}\n`;
    await fsp.appendFile(file, entry, 'utf8');
}
// List all daily memory files for a user, including legacy safe-id names.
async function listDailyFiles(userId) {
    try {
        const files = await fsp.readdir(DAILY_DIR);
        const value = String(userId || '');
        const prefixes = Array.from(new Set([safeUserId(value) + '.', legacySafeUserId(value) + '.']));
        return files.filter(file => prefixes.some(prefix => file.startsWith(prefix)) && file.endsWith('.md')).sort();
    }
    catch {
        return [];
    }
}
// Read all daily memory notes for Dream compaction.
async function readAllDailyContent(userId) {
    const files = await listDailyFiles(userId);
    const parts = [];
    for (const file of files) {
        try {
            const content = await fsp.readFile(path.join(DAILY_DIR, file), 'utf8');
            if (content.trim())
                parts.push(`--- ${file} ---\n${content.trim()}`);
        }
        catch {
            // Ignore a vanished or unreadable daily file and continue with the rest.
        }
    }
    return parts.join('\n\n');
}
// Return the total size of all daily memory files for a user.
async function getDailyTotalSize(userId) {
    const files = await listDailyFiles(userId);
    let total = 0;
    for (const file of files) {
        try {
            const stat = await fsp.stat(path.join(DAILY_DIR, file));
            total += stat.size;
        }
        catch {
            // Ignore a vanished daily file during size scans.
        }
    }
    return total;
}
// Read the current long-term memory file when it is small enough to compact.
async function readLongTermFile(userId) {
    for (const file of getLongTermFileCandidates(userId)) {
        try {
            const stat = await fsp.stat(file);
            if (!stat.isFile() || stat.size > MAX_LONG_TERM_FILE_BYTES)
                continue;
            return await fsp.readFile(file, 'utf8');
        }
        catch {
            // Try the next candidate.
        }
    }
    return '';
}
// Build LLM messages for auto-memory extraction.
function buildExtractMessages(recentMessages, existingDaily) {
    const trimmed = normalizeRecentMessages(recentMessages).map(message => {
        const content = String(message.content || '').slice(0, MAX_CHARS_PER_TURN);
        return `[${message.role}] ${content}`;
    }).join('\n');
    const messages = [{ role: 'system', content: EXTRACT_PROMPT }];
    if (existingDaily) {
        messages.push({ role: 'system', content: `Existing memories, avoid duplicates:\n${existingDaily.slice(0, 1000)}` });
    }
    messages.push({ role: 'user', content: trimmed });
    return messages;
}
// Return true when an LLM memory response contains no useful memory.
function isEmptyMemoryContent(content) {
    const normalized = String(content || '').trim().toLowerCase();
    return !normalized || normalized === 'empty' || normalized === 'none' || normalized === 'null' || normalized === 'no memory' || normalized === '空';
}
// Execute the LLM memory extraction call inside the S2 worker.
async function extractMemoryDirect(recentMessages, userId) {
    const normalized = normalizeRecentMessages(recentMessages);
    if (normalized.length < 2)
        return null;
    const existing = await readDailyFile(userId);
    const messages = buildExtractMessages(normalized, existing);
    const config = await loadConfig();
    const result = await requestChatCompletions(messages, config, { max_tokens: 500 });
    if (!result || result.type !== 'text')
        return null;
    const content = String(result.content || '').trim();
    if (isEmptyMemoryContent(content) || content.length < 3)
        return null;
    return content;
}
// Execute Dream compaction inside the S2 worker.
async function runDreamDirect(userId) {
    const dailyContent = await readAllDailyContent(userId);
    if (!dailyContent.trim())
        return { success: false, reason: 'no-daily-content' };
    const longTerm = await readLongTermFile(userId);
    const inputParts = [];
    if (longTerm.trim())
        inputParts.push(`[long-term memory]\n${longTerm.trim()}`);
    inputParts.push(`[daily memory]\n${dailyContent}`);
    const input = inputParts.join('\n\n');
    if (input.length > 30000)
        return { success: false, reason: 'input-too-large' };
    const config = await loadConfig();
    let result;
    try {
        result = await requestChatCompletions([
            { role: 'system', content: DREAM_PROMPT },
            { role: 'user', content: input },
        ], config, { max_tokens: 1500 });
    }
    catch {
        return { success: false, reason: 'llm-call-failed' };
    }
    if (!result || result.type !== 'text' || !result.content || String(result.content).trim().length < 5) {
        return { success: false, reason: 'empty-result' };
    }
    const consolidated = String(result.content).trim();
    await fsp.mkdir(DASHBOARD_MEMORY_DIR, { recursive: true });
    if (longTerm.trim())
        await fsp.writeFile(getBackupFile(userId), longTerm, 'utf8');
    await fsp.writeFile(getLongTermFile(userId), consolidated, 'utf8');
    const dailyFiles = await listDailyFiles(userId);
    for (const file of dailyFiles) {
        try {
            await fsp.unlink(path.join(DAILY_DIR, file));
        }
        catch {
            // Failed cleanup leaves the daily file for a later compaction retry.
        }
    }
    return { success: true, beforeSize: input.length, afterSize: consolidated.length, deletedFiles: dailyFiles.length };
}
// Count active S2 memory tasks for a user to avoid hidden queue explosions.
function countActiveMemoryTasks(kind, userId) {
    return listResourceTasks({ statuses: ['pending', 'claiming', 'running', 'deferred'], limit: 1000 })
        .filter(task => String(task.kind || '') === kind)
        .filter(task => String(task.userId || '') === String(userId || ''))
        .length;
}
// Convert a task-client result into a small submission result.
function normalizeMemorySubmission(result, kind) {
    const decision = String(result.admission?.decision || '');
    const accepted = !!result.accepted || decision === 'defer' || decision === 'queue';
    return {
        accepted,
        task: result.task,
        admission: result.admission,
        taskId: result.task?.id,
        status: accepted ? (decision || 'accepted') : 'rejected',
        message: `${kind} task ${accepted ? 'submitted' : 'rejected'}${result.task?.id ? `: ${result.task.id}` : ''}`,
    };
}
// Submit an auto-memory extraction task to S2 without running the LLM in the caller.
function submitAgentMemoryTask(options) {
    const userId = String(options.userId || '');
    if (!userId)
        return { accepted: false, status: 'invalid', message: 'userId is empty' };
    if (countActiveMemoryTasks('agent_memory', userId) >= 2) {
        return { accepted: false, status: 'skipped', message: 'active agent_memory task already exists' };
    }
    const recentMessages = normalizeRecentMessages(options.recentMessages || []);
    if (recentMessages.length < 2)
        return { accepted: false, status: 'skipped', message: 'not enough messages' };
    const result = submitWorkerTaskWithAdmission({
        kind: 'agent_memory',
        source: String(options.source || 'agent-auto-memory'),
        channelKey: 'dashboard',
        userId,
        priority: 95,
        timeoutMs: 120000,
        expiresAt: getExpiryIso(30 * 60 * 1000),
        payload: { userId, recentMessages },
        notify: { target: 'none', status: 'pending' },
    }, { checkAdmission: true, exclusive: true });
    return normalizeMemorySubmission(result, 'agent_memory');
}
// Submit a Dream compaction task to S2 without running the LLM in the caller.
function submitAgentMemoryCompactionTask(userId, source = 'agent-dream') {
    const safeUser = String(userId || '');
    if (!safeUser)
        return { accepted: false, status: 'invalid', message: 'userId is empty' };
    if (countActiveMemoryTasks('agent_memory_compaction', safeUser) >= 1) {
        return { accepted: false, status: 'skipped', message: 'active agent_memory_compaction task already exists' };
    }
    const result = submitWorkerTaskWithAdmission({
        kind: 'agent_memory_compaction',
        source,
        channelKey: 'dashboard',
        userId: safeUser,
        priority: 96,
        timeoutMs: 180000,
        expiresAt: getExpiryIso(6 * 60 * 60 * 1000),
        payload: { userId: safeUser },
        notify: { target: 'none', status: 'pending' },
    }, { checkAdmission: true, exclusive: true });
    return normalizeMemorySubmission(result, 'agent_memory_compaction');
}
// Run one auto-memory S2 task and optionally schedule Dream compaction.
async function runMemoryExtractionWorkerTask(task) {
    const userId = String(task?.payload?.userId || task?.userId || '');
    const recentMessages = normalizeRecentMessages(task?.payload?.recentMessages || []);
    const content = await extractMemoryDirect(recentMessages, userId);
    if (!content) {
        return { mode: 'agent_memory', extracted: false, reason: 'empty-memory-result' };
    }
    await appendDailyFile(userId, content);
    const dailyTotalSize = await getDailyTotalSize(userId);
    let compactionTaskId = '';
    let compactionStatus = '';
    if (dailyTotalSize > DREAM_SIZE_THRESHOLD) {
        const submission = submitAgentMemoryCompactionTask(userId, 'agent-memory-worker');
        compactionTaskId = String(submission.taskId || '');
        compactionStatus = submission.status;
    }
    return {
        mode: 'agent_memory',
        extracted: true,
        memoryLines: content.split(/\r?\n/).filter(Boolean).length,
        dailyTotalSize,
        compactionTaskId,
        compactionStatus,
        reason: 'memory extracted',
    };
}
// Run one Dream compaction S2 task.
async function runMemoryCompactionWorkerTask(task) {
    const userId = String(task?.payload?.userId || task?.userId || '');
    const result = await runDreamDirect(userId);
    if (!result.success) {
        const failed = result;
        return {
            mode: 'agent_memory_compaction',
            ...failed,
            reason: failed.reason,
        };
    }
    return {
        mode: 'agent_memory_compaction',
        ...result,
        reason: 'memory compacted',
    };
}
// Dispatch a memory task by kind.
async function runMemoryWorkerTask(task) {
    if (task?.kind === 'agent_memory')
        return runMemoryExtractionWorkerTask(task);
    if (task?.kind === 'agent_memory_compaction')
        return runMemoryCompactionWorkerTask(task);
    throw new Error(`unsupported memory worker task kind: ${String(task?.kind || '')}`);
}
// Return Dream status for Dashboard or commands without invoking the LLM.
function getDreamStatus(userId) {
    return getDailyTotalSize(userId).then(size => ({
        userId: safeUserId(String(userId || '')),
        dailyTotalSize: size,
        threshold: DREAM_SIZE_THRESHOLD,
        needsDream: size >= DREAM_SIZE_THRESHOLD,
    }));
}
module.exports = {
    DASHBOARD_MEMORY_DIR,
    DAILY_DIR,
    AUTO_MEMORY_INTERVAL,
    AUTO_MEMORY_WINDOW,
    DREAM_SIZE_THRESHOLD,
    submitAgentMemoryTask,
    submitAgentMemoryCompactionTask,
    runMemoryWorkerTask,
    extractMemoryDirect,
    runDreamDirect,
    getDailyTotalSize,
    getDreamStatus,
    getLongTermFile,
    readLongTermFile,
    safeUserId,
};
