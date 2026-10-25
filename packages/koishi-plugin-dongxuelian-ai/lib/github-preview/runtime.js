"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GithubPreviewRuntime = void 0;
exports.acquireGithubResources = acquireGithubResources;
const models_1 = require("./models");
const settings_1 = require("./settings");
const path = require("path");
const input_1 = require("./input");
const repositories_1 = require("./repositories");
const themes_1 = require("./themes");
const client_1 = require("./client");
const issue_renderer_1 = require("./issue-renderer");
const pull_card_1 = require("./pull-card");
const renderer_1 = require("./renderer");
const { h } = require('koishi');
const { hasAdminPermission } = require('../core/utils');
const { admitTask } = require('../resource-scheduler/admission');
const { acquireResourceGate, ResourceGateBusyTimeoutError } = require('../resource-gate/gate');
// Respect the existing global admission policy and S0 gate; no browser can bypass a report.
async function acquireGithubResources(context, group) {
    const budget = { taskId: context.taskId, kind: 'browser_action', source: 'github-preview', owner: 'github-preview', channelKey: group, userId: '', exclusive: true, priority: 60, minMemMb: models_1.GITHUB_LIMITS.minMemoryMb, degradable: true, deferable: false, queueTimeoutMs: models_1.GITHUB_LIMITS.queueMs, runTimeoutMs: models_1.GITHUB_LIMITS.runMs };
    const waitDeadline = Math.min(context.deadline, Date.now() + models_1.GITHUB_LIMITS.queueMs);
    while (Date.now() < waitDeadline) {
        (0, models_1.assertGithubWork)(context);
        const admission = admitTask(budget);
        if (['reject', 'downgrade', 'defer', 'silent_drop'].includes(admission.decision))
            throw new Error('当前资源不足或处于维护模式，请稍后重试');
        try {
            const gate = await acquireResourceGate({ ...budget, waitTimeoutMs: 0, timeoutMs: models_1.GITHUB_LIMITS.runMs, step: 'github_preview' });
            if (context.signal.aborted) {
                gate.release('cancelled_before_run');
                context.signal.throwIfAborted();
            }
            const checked = admitTask(budget);
            if (checked.decision !== 'run_now') {
                gate.release('admission_changed');
                throw new Error('当前资源不足，请稍后重试');
            }
            return () => gate.release('github_preview_finished');
        }
        catch (error) {
            if (!(error instanceof ResourceGateBusyTimeoutError))
                throw error;
        }
        await (0, models_1.waitGithubWork)(Math.max(1, Math.min(200, waitDeadline - Date.now())), context.signal);
    }
    throw new Error('截图资源繁忙，请稍后重试');
}
class GithubPreviewRuntime {
    // Own one bounded preview queue; dependencies are explicit for offline behavior tests.
    constructor(settings = new settings_1.GithubPreviewSettings(), dependencies = {}, repositories = new repositories_1.GithubGroupRepositories(path.dirname(settings.file)), themes = new themes_1.GithubPreviewThemes(path.dirname(settings.file))) {
        this.themes = themes;
        this.queue = [];
        this.pumping = false;
        this.disposed = false;
        this.cooldowns = new Map();
        this.messages = new Map();
        this.images = new Map();
        this.lifetime = new AbortController();
        this.settings = settings;
        this.repositories = repositories;
        const client = new client_1.GithubPreviewClient();
        this.deps = { lookup: (target, context) => client.lookup(target, context), screenshot: issue_renderer_1.renderGithubIssue, renderPull: (metadata, context, theme) => (0, pull_card_1.renderGithubPullCard)(metadata, context, theme), render: renderer_1.renderGithubCard, acquire: acquireGithubResources, log: message => console.warn(message), ...dependencies };
        this.unsubscribe = settings.onRemoved(group => this.cancelGroup(group));
        this.unsubscribeRepositories = repositories.onChanged(group => this.cancelGroup(group));
    }
    // Only enabled guild messages and reserved management commands enter this feature.
    accepts(session, plain) {
        if (this.disposed || (session.selfId && String(session.userId || session.author?.id) === session.selfId))
            return false;
        return (0, input_1.isGithubPreviewCommand)(plain) || (!session.isDirect && !!session.guildId && this.settings.enabled(session.guildId) && this.targets(session, plain).length > 0);
    }
    // Shorthand must occupy the raw message too; mentions, images and surrounding text cannot trigger it.
    targets(session, plain) {
        const links = (0, input_1.extractGithubTargets)(plain);
        if (links.length)
            return links;
        if (session.content !== undefined && session.content !== plain)
            return [];
        const target = (0, input_1.resolveGithubNumber)(plain, this.repositories.get(session.guildId || ''));
        return target ? [target] : [];
    }
    // --- 管理与入队 --- //
    // Authenticate management, then apply durable, idempotent changes without model calls.
    async command(session, plain) {
        if (/^GitHub查询状态$/i.test(plain))
            return !session.isDirect && session.guildId ? `本群 GitHub 查询：${this.settings.enabled(session.guildId) ? '开启' : '关闭'}` : '请在群中查看 GitHub 查询状态。';
        if (!hasAdminPermission(session))
            return '只有指定管理员能操作这个命令。';
        if (/^GitHub群主题/i.test(plain))
            return (0, themes_1.handleGithubThemeCommand)(session.guildId, session.isDirect, plain, this.themes);
        if (/^GitHub群项目/i.test(plain))
            return (0, repositories_1.handleGithubRepositoryCommand)(session.guildId, session.isDirect, plain, this.repositories, this.deps.lookup, this.lifetime.signal);
        if (/^GitHub查询群查看$/i.test(plain)) {
            const groups = this.settings.list();
            return groups.length ? 'GitHub 查询群：\n' + groups.join('\n') : 'GitHub 查询群为空，所有群均关闭。';
        }
        const match = plain.match(/^GitHub查询群(添加|删除)\s*([1-9]\d*)$/i);
        if (!match || !(0, settings_1.normalizeGithubGroup)(match[2]))
            return '用法：GitHub查询群添加 <群号> / GitHub查询群删除 <群号> / GitHub查询群查看 / GitHub查询状态';
        try {
            const enabled = match[1] === '添加', changed = await this.settings.update(match[2], enabled);
            return changed ? `已${enabled ? '开启' : '关闭'} GitHub 查询群：${match[2]}` : `该群 GitHub 查询已经${enabled ? '开启' : '关闭'}：${match[2]}`;
        }
        catch {
            return 'GitHub 查询群配置保存失败，设置未更改。';
        }
    }
    // Queue one message with a real expiry; deletion removes queued jobs immediately.
    async handle(session, plain) {
        if (!this.accepts(session, plain))
            return undefined;
        if ((0, input_1.isGithubPreviewCommand)(plain))
            return this.command(session, plain);
        const group = session.guildId, targets = this.targets(session, plain);
        const now = Date.now(), messageKey = session.messageId ? group + ':' + session.messageId : '';
        if (messageKey && this.messages.has(messageKey))
            return undefined;
        if (messageKey)
            this.messages.set(messageKey, now);
        for (const [key, time] of this.messages)
            if (now - time > 300000 || this.messages.size > 2000)
                this.messages.delete(key);
        const selected = targets.slice(0, models_1.GITHUB_LIMITS.maxTargets).filter(target => {
            const key = group + ':' + target.key, previous = this.cooldowns.get(key);
            if (previous && now - previous < models_1.GITHUB_LIMITS.cooldownMs)
                return false;
            this.cooldowns.set(key, now);
            return true;
        });
        for (const [key, time] of this.cooldowns)
            if (now - time > models_1.GITHUB_LIMITS.cooldownMs || this.cooldowns.size > 2000)
                this.cooldowns.delete(key);
        if (!selected.length)
            return undefined;
        if (this.queue.length >= models_1.GITHUB_LIMITS.maxQueued)
            return 'GitHub 查询队列已满，请稍后重试。';
        await new Promise(finish => {
            const job = { group, session, targets: selected, version: this.settings.version(group), controller: new AbortController(), finish, overflow: targets.length > models_1.GITHUB_LIMITS.maxTargets };
            job.timer = setTimeout(() => {
                const index = this.queue.indexOf(job);
                if (index < 0)
                    return;
                this.queue.splice(index, 1);
                if (this.valid(job))
                    void this.deliver(job, 'GitHub 查询排队超时，请稍后重试。', { signal: job.controller.signal, deadline: Date.now() + 5000, taskId: 'github-queue-expired' }).catch(() => { }).finally(finish);
                else
                    finish();
            }, models_1.GITHUB_LIMITS.queueMs);
            this.queue.push(job);
            void this.pump();
        });
        return undefined;
    }
    // --- 队列与取消 --- //
    // A generation check stops deleted/re-added groups and disposed runtimes from sending.
    valid(job) { return !this.disposed && !job.controller.signal.aborted && this.settings.enabled(job.group) && this.settings.version(job.group) === job.version; }
    // Abort only this group's work; another group's generation is unaffected.
    cancelGroup(group) {
        for (const key of this.cooldowns.keys())
            if (key.startsWith(group + ':'))
                this.cooldowns.delete(key);
        for (const job of [...this.queue])
            if (job.group === group) {
                job.controller.abort(new Error('查询群配置已更改'));
                clearTimeout(job.timer);
                this.queue.splice(this.queue.indexOf(job), 1);
                job.finish();
            }
        if (this.active?.group === group)
            this.active.controller.abort(new Error('查询群配置已更改'));
    }
    // Drain globally in order; the in-memory queue never owns more than one running task.
    async pump() {
        if (this.pumping)
            return;
        this.pumping = true;
        try {
            while (this.queue.length && !this.disposed) {
                const job = this.queue.shift();
                clearTimeout(job.timer);
                this.active = job;
                try {
                    if (this.valid(job))
                        await this.run(job);
                }
                catch (error) {
                    this.deps.log('github-preview task_failed: ' + (error instanceof Error ? error.name : 'unknown'));
                }
                finally {
                    job.finish();
                    this.active = undefined;
                }
            }
        }
        finally {
            this.pumping = false;
        }
    }
    // --- 缓存、发送与任务预算 --- //
    // Keep only complete images, bounded by item count and total encoded bytes.
    cacheImage(key, entry) {
        if (entry.result.incomplete || entry.bytes > models_1.GITHUB_LIMITS.imageBytes)
            return;
        // Finished images need only their caption fields, not another retained copy of the HTML body.
        this.images.delete(key);
        this.images.set(key, { ...entry, metadata: { ...entry.metadata, bodyHtml: undefined } });
        while (this.images.size > models_1.GITHUB_LIMITS.cacheEntries || [...this.images.values()].reduce((sum, item) => sum + item.bytes, 0) > models_1.GITHUB_LIMITS.cacheBytes)
            this.images.delete(this.images.keys().next().value);
    }
    // Verify permission immediately before each send and never retry an uncertain adapter result.
    async deliver(job, content, context) {
        (0, models_1.assertGithubWork)(context);
        if (!this.valid(job))
            return;
        let timer;
        try {
            await Promise.race([job.session.send(content), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('GitHub 消息发送结果未知')), Math.max(1, context.deadline - Date.now())); })]);
        }
        catch (error) {
            this.deps.log('github-preview send_failed_or_unknown: ' + error.name);
            throw error;
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    // Process all targets under one absolute task budget, with safe text fallbacks by stage.
    async run(job) {
        const context = { signal: job.controller.signal, deadline: Date.now() + models_1.GITHUB_LIMITS.runMs, taskId: 'github-preview-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) };
        const timer = setTimeout(() => job.controller.abort(new Error('GitHub 查询处理超时')), models_1.GITHUB_LIMITS.runMs);
        const started = Date.now();
        // Batch image counting needs a final delivery stage within the unchanged 45-second task budget.
        const processingDeadline = context.deadline - 5000;
        this.deps.log(`github-preview started task=${context.taskId} group=${job.group} targets=${job.targets.map(target => target.key).join(',')}`);
        const replies = [];
        let release;
        try {
            if (job.overflow)
                await this.deliver(job, '每条消息最多处理前 3 个不同的 GitHub 链接。', context);
            for (const target of job.targets) {
                if (!this.valid(job))
                    break;
                if (processingDeadline - Date.now() < 1000) {
                    const content = '剩余链接未处理：本次查询已到处理时限。';
                    if (replies.length)
                        replies.push({ content, imageCount: 0 });
                    else
                        await this.deliver(job, content, context);
                    break;
                }
                const theme = this.themes.theme(job.group);
                const cacheKey = target.key + (target.kind === 'pull' ? `:pull-board-body-v3:${theme}:` : ['issue'].includes(target.kind) ? ':body-industrial-v2:' : ':card-industrial-v2:') + 'padding-' + models_1.GITHUB_LIMITS.padding;
                const cached = this.images.get(cacheKey);
                let metadata, result, note = '', text = '';
                if (cached && Date.now() - cached.result.capturedAt < models_1.GITHUB_LIMITS.cacheMs) {
                    metadata = cached.metadata;
                    result = cached.result;
                    note = '缓存数据，捕获于 ' + new Date(result.capturedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
                }
                else {
                    const targetController = new AbortController();
                    const cancelTarget = () => targetController.abort(context.signal.reason);
                    context.signal.addEventListener('abort', cancelTarget, { once: true });
                    const work = { ...context, signal: targetController.signal, deadline: Math.min(processingDeadline, Date.now() + models_1.GITHUB_LIMITS.targetMs) };
                    const targetTimer = setTimeout(() => targetController.abort(new Error('GitHub 单个目标处理超时（最多30秒）')), Math.max(0, work.deadline - Date.now()));
                    try {
                        metadata = await this.deps.lookup(target, work);
                        (0, models_1.assertGithubWork)(work);
                        if (!release)
                            release = await this.deps.acquire(work, job.group);
                        (0, models_1.assertGithubWork)(work);
                        result = metadata.target.kind === 'pull' ? await this.deps.renderPull(metadata, work, theme) : metadata.target.kind === 'issue' ? await this.deps.screenshot(metadata, work) : await this.deps.render(metadata, work);
                        (0, models_1.assertGithubWork)(work);
                        this.cacheImage(cacheKey, { result, metadata, bytes: result.images.reduce((sum, image) => sum + image.length, 0) });
                        if (result.incomplete)
                            note = result.note || '正文附件未完整载入，请查看原文。';
                    }
                    catch (error) {
                        result = undefined;
                        if (!this.valid(job))
                            break;
                        if (error instanceof client_1.GithubQueryError && error.transient && cached && Date.now() - cached.result.capturedAt < models_1.GITHUB_LIMITS.staleMs) {
                            result = cached.result;
                            metadata = cached.metadata;
                            note = '缓存数据，捕获于 ' + new Date(result.capturedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
                        }
                        else
                            text = `${metadata ? (0, renderer_1.githubTextFallback)(metadata) : target.url}\n${error instanceof client_1.GithubQueryError ? error.message : error instanceof Error ? error.message : '查询失败'}${metadata ? '\n图片生成失败，已返回文字信息。' : ''}`;
                        this.deps.log(`github-preview stage_failed target=${target.key} stage=${metadata ? 'render' : 'metadata'} status=${error instanceof client_1.GithubQueryError ? error.status : 0} elapsedMs=${Date.now() - started} reason=${error instanceof Error ? error.message : 'unknown'}`);
                    }
                    finally {
                        clearTimeout(targetTimer);
                        context.signal.removeEventListener('abort', cancelTarget);
                    }
                }
                if (!this.valid(job))
                    break;
                // Collect actual output, including cache hits, before deciding whether this request needs a record.
                if (result && metadata)
                    replies.push({ content: [...(note ? [h.text(note + '\n')] : []), ...result.images.map(image => h.image(image, 'image/png')), h.text('\n' + metadata.url)], imageCount: result.images.length });
                else if (replies.length)
                    replies.push({ content: text, imageCount: 0 });
                else
                    await this.deliver(job, text, context);
            }
            // Sending stays outside processing catches: an uncertain adapter result must never cause a retry.
            if (replies.reduce((sum, reply) => sum + reply.imageCount, 0) > 3) {
                const contents = replies.flatMap(reply => typeof reply.content === 'string' ? [h.text(reply.content)] : reply.content);
                await this.deliver(job, h('figure', {}, contents.map(content => h('message', {}, content))), context);
            }
            else
                for (const reply of replies) {
                    if (!this.valid(job))
                        break;
                    await this.deliver(job, reply.content, context);
                }
        }
        finally {
            clearTimeout(timer);
            if (release)
                release();
            this.deps.log(`github-preview finished task=${context.taskId} group=${job.group} elapsedMs=${Date.now() - started} cancelled=${context.signal.aborted}`);
        }
    }
    // Plugin disposal cancels every task and releases the removal subscription.
    dispose() {
        this.disposed = true;
        this.unsubscribe();
        this.unsubscribeRepositories();
        this.lifetime.abort(new Error('GitHub 查询已停止'));
        for (const group of new Set([...this.queue.map(job => job.group), ...(this.active ? [this.active.group] : [])]))
            this.cancelGroup(group);
        this.images.clear();
        this.messages.clear();
        this.cooldowns.clear();
    }
}
exports.GithubPreviewRuntime = GithubPreviewRuntime;
