"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GithubPreviewClient = exports.GithubQueryError = void 0;
const models_1 = require("./models");
const input_1 = require("./input");
class GithubQueryError extends Error {
    // Preserve only safe status metadata, never raw upstream response bodies or tokens.
    constructor(message, status = 0, transient = false) {
        super(message);
        this.status = status;
        this.transient = transient;
        this.name = 'GithubQueryError';
    }
}
exports.GithubQueryError = GithubQueryError;
// --- 官方字段合同 --- //
// Validate an official scalar field; unknown contracts are rejected instead of guessed.
function githubString(data, field, nullable = false) {
    const value = data[field];
    if (nullable && value === null)
        return '';
    if (typeof value !== 'string')
        throw new GithubQueryError('官方字段类型异常：' + field);
    return value;
}
// Validate counts without converting unknown or absent values into zero.
function githubCount(data, field) {
    const value = data[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new GithubQueryError('官方计数字段异常：' + field);
    return String(value);
}
// Read a structured official object with a fixed, non-recursive contract.
function githubObject(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new GithubQueryError('官方对象字段异常：' + field);
    return value;
}
// Keep only bounded official display fields, including the requested HTML representation.
function selectGithubFields(raw) {
    const fields = ['full_name', 'name', 'login', 'html_url', 'private', 'description', 'language', 'stargazers_count', 'forks_count', 'archived', 'updated_at', 'license', 'type', 'bio', 'avatar_url', 'public_repos', 'followers', 'following', 'created_at', 'title', 'number', 'state', 'merged', 'draft', 'pull_request', 'labels', 'additions', 'deletions', 'changed_files', 'commits', 'comments', 'review_comments', 'closed_at', 'merged_at', 'mergeable_state'];
    const result = {};
    if (raw.body_html !== undefined) {
        const body = githubString(raw, 'body_html', true);
        if (Buffer.byteLength(body, 'utf8') > models_1.GITHUB_LIMITS.bodyBytes)
            throw new GithubQueryError('正文超过大小限制，请查看原文');
        result.body_html = body;
    }
    for (const field of fields)
        if (raw[field] !== undefined)
            result[field] = raw[field];
    if (raw.user) {
        const user = githubObject(raw.user, 'user');
        result.user = { login: user.login, avatar_url: user.avatar_url };
    }
    if (raw.owner) {
        const owner = githubObject(raw.owner, 'owner');
        result.owner = { login: owner.login, avatar_url: owner.avatar_url };
    }
    if (raw.merged_by) {
        const mergedBy = githubObject(raw.merged_by, 'merged_by');
        result.merged_by = { login: mergedBy.login, avatar_url: mergedBy.avatar_url };
    }
    if (raw.milestone) {
        const milestone = githubObject(raw.milestone, 'milestone');
        result.milestone = { title: milestone.title };
    }
    if (raw.head) {
        const head = githubObject(raw.head, 'head');
        result.head = { ref: head.ref, sha: head.sha };
    }
    if (raw.base) {
        const base = githubObject(raw.base, 'base');
        result.base = { ref: base.ref, sha: base.sha };
    }
    if (raw.assignees)
        result.assignees = selectGithubUsers(raw.assignees, 'assignees');
    if (raw.requested_reviewers)
        result.requested_reviewers = selectGithubUsers(raw.requested_reviewers, 'requested_reviewers');
    return result;
}
// Bound official user lists to display identities only.
function selectGithubUsers(value, field) {
    if (!Array.isArray(value) || value.length > 10)
        throw new GithubQueryError('官方用户列表字段异常：' + field);
    return value.map(item => { const user = githubObject(item, field); return { login: user.login, avatar_url: user.avatar_url }; });
}
// --- PR 详情数据合同（对应进度看板详情视图） --- //
// Read an optional count strictly: absent stays absent, anomalies are rejected.
function githubMetric(data, field) {
    const value = data[field];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new GithubQueryError('官方计数字段异常：' + field);
    return value;
}
// Read an optional nullable official string under the same contract.
function githubOptionalText(data, field) {
    if (data[field] === undefined)
        return undefined;
    return githubString(data, field, true) || undefined;
}
// Project verified pull counts and refs; the caller degrades the whole block on any anomaly.
function buildGithubPullStats(pull) {
    const stats = {};
    const commits = githubMetric(pull, 'commits');
    if (commits !== undefined)
        stats.commits = commits;
    const additions = githubMetric(pull, 'additions');
    if (additions !== undefined)
        stats.additions = additions;
    const deletions = githubMetric(pull, 'deletions');
    if (deletions !== undefined)
        stats.deletions = deletions;
    const changedFiles = githubMetric(pull, 'changed_files');
    if (changedFiles !== undefined)
        stats.changedFiles = changedFiles;
    const comments = githubMetric(pull, 'comments');
    if (comments !== undefined)
        stats.comments = comments;
    const reviewComments = githubMetric(pull, 'review_comments');
    if (reviewComments !== undefined)
        stats.reviewComments = reviewComments;
    const updatedAt = githubOptionalText(pull, 'updated_at');
    if (updatedAt !== undefined)
        stats.updatedAt = updatedAt;
    const closedAt = githubOptionalText(pull, 'closed_at');
    if (closedAt !== undefined)
        stats.closedAt = closedAt;
    const mergedAt = githubOptionalText(pull, 'merged_at');
    if (mergedAt !== undefined)
        stats.mergedAt = mergedAt;
    const mergeableState = githubOptionalText(pull, 'mergeable_state');
    if (mergeableState !== undefined)
        stats.mergeableState = mergeableState;
    if (pull.head) {
        const head = githubObject(pull.head, 'head');
        const ref = githubOptionalText(head, 'ref');
        const sha = githubOptionalText(head, 'sha');
        if (ref !== undefined)
            stats.headRef = ref;
        if (sha !== undefined)
            stats.headSha = sha;
    }
    if (pull.base) {
        const base = githubObject(pull.base, 'base');
        const ref = githubOptionalText(base, 'ref');
        if (ref !== undefined)
            stats.baseRef = ref;
    }
    if (pull.merged_by) {
        const mergedBy = githubObject(pull.merged_by, 'merged_by');
        const login = githubOptionalText(mergedBy, 'login');
        if (login !== undefined)
            stats.mergedBy = login;
    }
    if (pull.milestone)
        stats.milestone = githubString(githubObject(pull.milestone, 'milestone'), 'title', true) || undefined;
    if (pull.assignees)
        stats.assignees = selectGithubUsers(pull.assignees, 'assignees').map(user => githubString(user, 'login'));
    if (pull.requested_reviewers)
        stats.requestedReviewers = selectGithubUsers(pull.requested_reviewers, 'requested_reviewers').map(user => githubString(user, 'login'));
    return stats;
}
// Validate the official reviews list payload into bounded display records.
function selectGithubReviews(payload) {
    if (!Array.isArray(payload) || payload.length > 100)
        throw new GithubQueryError('官方评审列表字段异常');
    const reviews = payload.map(item => { const review = githubObject(item, 'review'); return { login: githubString(githubObject(review.user, 'review.user'), 'login'), state: githubString(review, 'state'), submitted_at: githubString(review, 'submitted_at', true) }; });
    return { reviews };
}
// Keep each reviewer's latest verdict; a later comment never erases an approval state.
function latestGithubReviews(shaped) {
    const byLogin = new Map();
    for (const review of shaped) {
        if (review.state === 'COMMENTED' && byLogin.has(review.login))
            continue;
        byLogin.set(review.login, { login: review.login, state: review.state, submittedAt: review.submitted_at || undefined });
    }
    return { verdicts: [...byLogin.values()].slice(0, 8), total: shaped.length };
}
// Validate the official check-runs payload into bounded display records.
function selectGithubCheckRuns(payload) {
    const data = githubObject(payload, 'check-runs');
    if (!Array.isArray(data.check_runs) || data.check_runs.length > 100)
        throw new GithubQueryError('官方检查字段异常：check_runs');
    return { check_runs: data.check_runs.slice(0, 30).map(item => { const run = githubObject(item, 'check_run'); return { name: githubString(run, 'name'), status: githubString(run, 'status'), conclusion: githubString(run, 'conclusion', true), html_url: githubString(run, 'html_url', true) }; }) };
}
// Bucket and rank official check runs exactly like the progress board's summary.
function summarizeGithubChecks(raw) {
    if (!raw.length)
        return undefined;
    const counts = { failure: 0, pending: 0, success: 0, neutral: 0, skipped: 0 };
    const runs = raw.map(item => {
        const run = githubObject(item, 'check_run');
        const status = githubString(run, 'status'), conclusion = githubString(run, 'conclusion', true);
        const bucket = status !== 'completed' ? 'pending' : conclusion === 'success' ? 'success' : ['failure', 'timed_out', 'startup_failure', 'action_required', 'cancelled'].includes(conclusion) ? 'failure' : conclusion === 'skipped' ? 'skipped' : 'neutral';
        counts[bucket]++;
        return { name: githubString(run, 'name'), status, conclusion: conclusion || undefined, bucket };
    });
    const overall = counts.failure ? 'failure' : counts.pending ? 'pending' : counts.success ? 'success' : 'neutral';
    const order = { failure: 0, pending: 1, success: 2, neutral: 3, skipped: 4 };
    runs.sort((first, second) => order[first.bucket] - order[second.bucket]);
    return { overall, total: runs.length, counts, runs: runs.slice(0, 10) };
}
// Consume a bounded JSON response with the same request cancellation signal.
async function readGithubJson(response) {
    return githubObject(await readGithubPayload(response), 'response');
}
// Read any bounded official JSON payload; list endpoints answer with top-level arrays.
async function readGithubPayload(response) {
    const reader = response.body?.getReader();
    if (!reader)
        throw new GithubQueryError('官方接口返回空响应');
    const chunks = [];
    let bytes = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done)
                break;
            bytes += part.value.length;
            if (bytes > 2 * 1024 * 1024)
                throw new GithubQueryError('官方响应超过大小限制');
            chunks.push(part.value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new GithubQueryError('官方接口返回无效数据');
    }
}
// --- 串行请求与缓存 --- //
class GithubPreviewClient {
    // Use a dedicated read-only token; transport injection is used by offline protocol tests.
    constructor(transport = (...args) => fetch(...args), token = process.env.GITHUB_PREVIEW_TOKEN || '') {
        this.transport = transport;
        this.token = token;
        this.cache = new Map();
        this.serial = Promise.resolve();
        this.blockedUntil = 0;
    }
    // Serialize official requests and merge repeated calls via the metadata cache.
    async request(route, context, select) {
        const job = this.serial.catch(() => { }).then(() => this.requestSerial(route, context, select));
        this.serial = job;
        return job;
    }
    // Revalidate metadata using ETag; enforce rate limits, bounded retries and safe redirects.
    async requestSerial(route, context, select) {
        (0, models_1.assertGithubWork)(context);
        const accept = /\/(issues|pulls)\/\d+$/.test(route) ? 'application/vnd.github.html+json' : 'application/vnd.github+json';
        // Rendered bodies contain short-lived signed image URLs: refresh HTML without conditional reuse.
        const conditional = accept === 'application/vnd.github+json';
        const cacheKey = accept + ':' + route;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.checkedAt < (cached.missing ? 60000 : models_1.GITHUB_LIMITS.cacheMs)) {
            if (cached.missing)
                throw new GithubQueryError('资源不存在或当前不可访问', 404);
            return cached;
        }
        if (this.blockedUntil > Date.now())
            throw new GithubQueryError('GitHub 请求受限，请稍后重试', 429, true);
        const controller = new AbortController();
        const requestStarted = Date.now();
        const cancelGithubApiRequest = () => controller.abort(context.signal.reason);
        context.signal.addEventListener('abort', cancelGithubApiRequest, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('GitHub 接口请求超时')), Math.max(1, Math.min(8000, context.deadline - Date.now())));
        try {
            let response;
            for (let attempt = 0; attempt < 2; attempt++) {
                let url = 'https://api.github.com' + route;
                try {
                    for (let redirects = 0; redirects < 4; redirects++) {
                        response = await this.transport(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'LianLianBot-GitHub-Preview', Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}), ...(conditional && cached?.etag ? { 'If-None-Match': cached.etag } : {}) } });
                        if (![301, 302, 307, 308].includes(response.status))
                            break;
                        const next = new URL(response.headers.get('location') || '', url);
                        await response.body?.cancel();
                        if (next.origin !== 'https://api.github.com' || next.username || next.password)
                            throw new GithubQueryError('官方接口跳转地址不受信任');
                        url = next.href;
                        if (redirects === 3)
                            throw new GithubQueryError('官方接口跳转次数过多');
                    }
                }
                catch (error) {
                    if (error instanceof GithubQueryError || controller.signal.aborted || attempt === 1)
                        throw error;
                    await (0, models_1.waitGithubWork)(200, controller.signal);
                    continue;
                }
                if (response.status < 500 || attempt === 1)
                    break;
                await response.body?.cancel();
                await (0, models_1.waitGithubWork)(200, controller.signal);
            }
            if (!response)
                throw new GithubQueryError('GitHub 未返回响应', 0, true);
            console.info(`github-preview api target=${route} status=${response.status} elapsedMs=${Date.now() - requestStarted}`);
            if (response.status === 304 && conditional && cached?.value) {
                cached.checkedAt = Date.now();
                await response.body?.cancel();
                return cached;
            }
            if (!response.ok) {
                const status = response.status;
                const remaining = response.headers.get('x-ratelimit-remaining');
                const retryAfter = Number(response.headers.get('retry-after') || 0);
                let rateLimited = status === 429 || (status === 403 && (remaining === '0' || retryAfter > 0));
                // 403 may mean permission denied; only confirmed rate-limit text enables suspension.
                const error = await readGithubJson(response).catch(() => ({}));
                if (status === 403 && typeof error.message === 'string' && /rate limit/i.test(error.message))
                    rateLimited = true;
                if (rateLimited) {
                    const resetAt = remaining === '0' ? Number(response.headers.get('x-ratelimit-reset') || 0) * 1000 : 0;
                    this.blockedUntil = Math.max(Date.now() + (retryAfter || 60) * 1000, resetAt);
                }
                if (status === 404)
                    this.remember(cacheKey, { missing: true, fetchedAt: Date.now(), checkedAt: Date.now() });
                const message = rateLimited ? 'GitHub 请求受限，请稍后重试' : { 401: 'GitHub 认证配置不可用', 403: 'GitHub 拒绝访问', 404: '资源不存在或当前不可访问', 410: '资源已移除' }[status] || 'GitHub 服务请求失败';
                throw new GithubQueryError(message, status, rateLimited || status >= 500);
            }
            const value = select ? select(await readGithubPayload(response)) : selectGithubFields(await readGithubJson(response));
            const entry = { value, etag: response.headers.get('etag') || undefined, fetchedAt: Date.now(), checkedAt: Date.now() };
            this.remember(cacheKey, entry);
            return entry;
        }
        catch (error) {
            if (context.signal.aborted)
                throw context.signal.reason;
            if (error instanceof GithubQueryError)
                throw error;
            throw new GithubQueryError(controller.signal.aborted ? 'GitHub 接口请求超时' : 'GitHub 网络请求失败', 0, true);
        }
        finally {
            clearTimeout(timer);
            context.signal.removeEventListener('abort', cancelGithubApiRequest);
        }
    }
    // Bound count and encoded bytes now that official HTML is retained alongside metadata.
    remember(route, value) {
        this.cache.delete(route);
        this.cache.set(route, value);
        while (this.cache.size > models_1.GITHUB_LIMITS.cacheEntries || [...this.cache.values()].reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), 'utf8'), 0) > models_1.GITHUB_LIMITS.metadataBytes)
            this.cache.delete(this.cache.keys().next().value);
    }
    // Resolve verified public metadata and normalize Issue aliases to real PR targets.
    async lookup(target, context) {
        const encode = encodeURIComponent;
        let repository;
        if (target.repo) {
            repository = (await this.request(`/repos/${encode(target.owner)}/${encode(target.repo)}`, context)).value;
            if (typeof repository.private !== 'boolean')
                throw new GithubQueryError('官方字段类型异常：private');
            if (repository.private)
                throw new GithubQueryError('仅支持公开仓库', 403);
        }
        const route = target.kind === 'repository' ? `/repos/${encode(target.owner)}/${encode(target.repo)}`
            : target.kind === 'user' ? `/users/${encode(target.owner)}`
                : `/repos/${encode(target.owner)}/${encode(target.repo)}/${target.kind === 'issue' ? 'issues' : 'pulls'}/${target.number}`;
        const entry = await this.request(route, context);
        const value = entry.value;
        if (target.kind === 'issue' && value.pull_request)
            return this.lookup({ ...target, kind: 'pull', key: target.key.replace(/^issue:/, 'pull:') }, context);
        const url = githubString(value, 'html_url');
        const canonical = (0, input_1.parseGithubTarget)(url);
        if (!canonical || canonical.kind !== target.kind)
            throw new GithubQueryError('官方资源地址与类型不匹配');
        if (target.number !== undefined && (canonical.number !== target.number || value.number !== target.number))
            throw new GithubQueryError('官方资源编号不匹配');
        if (repository) {
            const publicRepository = (0, input_1.parseGithubTarget)(githubString(repository, 'html_url'));
            if (!publicRepository || publicRepository.kind !== 'repository' || canonical.owner.toLowerCase() !== publicRepository.owner.toLowerCase() || canonical.repo?.toLowerCase() !== publicRepository.repo?.toLowerCase())
                throw new GithubQueryError('官方资源与已验证公开仓库不匹配');
        }
        const metadata = { target: canonical, title: '', url, fetchedAt: entry.fetchedAt, facts: [] };
        if (target.kind === 'user') {
            metadata.title = githubString(value, 'name', true) || githubString(value, 'login');
            metadata.description = githubString(value, 'bio', true);
            metadata.avatar = githubString(value, 'avatar_url');
            metadata.author = githubString(value, 'login');
            metadata.facts = [['账户', githubString(value, 'type') === 'Organization' ? '组织账户' : '用户'], ['登录名', githubString(value, 'login')], ['公开仓库', githubCount(value, 'public_repos')], ['关注者（公开可见）', githubCount(value, 'followers')], ['关注中（公开可见）', githubCount(value, 'following')], ['注册时间', githubString(value, 'created_at')]];
        }
        else if (target.kind === 'repository') {
            metadata.title = githubString(value, 'full_name');
            metadata.description = githubString(value, 'description', true);
            const owner = githubObject(value.owner, 'owner');
            metadata.author = githubString(owner, 'login');
            metadata.avatar = githubString(owner, 'avatar_url');
            const license = value.license === null ? null : githubObject(value.license, 'license');
            metadata.facts = [['主要语言', githubString(value, 'language', true) || '未提供'], ['Stars', githubCount(value, 'stargazers_count')], ['Forks', githubCount(value, 'forks_count')], ['许可证', license ? githubString(license, 'name') : '未提供'], ['更新时间', githubString(value, 'updated_at')]];
            if (value.archived === true)
                metadata.facts.push(['归档', '已归档']);
        }
        else {
            metadata.title = githubString(value, 'title');
            metadata.bodyHtml = githubString(value, 'body_html', true);
            metadata.createdAt = githubString(value, 'created_at');
            const state = githubString(value, 'state');
            if (!['open', 'closed'].includes(state))
                throw new GithubQueryError('官方状态字段异常');
            if (target.kind === 'pull' && (typeof value.merged !== 'boolean' || typeof value.draft !== 'boolean'))
                throw new GithubQueryError('官方合并请求状态字段异常');
            metadata.state = target.kind === 'pull' && value.merged ? '已合并' : state === 'closed' ? '已关闭' : value.draft ? '草稿' : '开启中';
            const user = githubObject(value.user, 'user');
            metadata.author = githubString(user, 'login');
            metadata.avatar = githubString(user, 'avatar_url');
            if (!Array.isArray(value.labels))
                throw new GithubQueryError('官方标签字段异常');
            metadata.labels = value.labels.map(item => { const label = githubObject(item, 'labels'); return { name: githubString(label, 'name'), color: githubString(label, 'color') }; });
            if (target.kind === 'pull')
                metadata.pull = await this.lookupPullExtras(canonical, value, context);
        }
        return metadata;
    }
    // Best-effort PR detail extras; every failed part degrades by name instead of failing the preview.
    async lookupPullExtras(target, pull, context) {
        const encode = encodeURIComponent;
        const partial = [];
        let stats;
        try {
            stats = buildGithubPullStats(pull);
        }
        catch {
            partial.push('统计');
        }
        let reviews = [], reviewTotal = 0;
        try {
            const entry = await this.request(`/repos/${encode(target.owner)}/${encode(target.repo)}/pulls/${target.number}/reviews?per_page=100`, context, selectGithubReviews);
            const latest = latestGithubReviews(entry.value.reviews);
            reviews = latest.verdicts;
            reviewTotal = latest.total;
        }
        catch (error) {
            if (context.signal.aborted || Date.now() >= context.deadline)
                throw error;
            partial.push('评审');
        }
        let checks;
        if (stats?.headSha) {
            try {
                const entry = await this.request(`/repos/${encode(target.owner)}/${encode(target.repo)}/commits/${encode(stats.headSha)}/check-runs?per_page=100`, context, selectGithubCheckRuns);
                checks = summarizeGithubChecks(entry.value.check_runs);
            }
            catch (error) {
                if (context.signal.aborted || Date.now() >= context.deadline)
                    throw error;
                partial.push('检查');
            }
        }
        return { stats, reviews, reviewTotal, checks, partial };
    }
}
exports.GithubPreviewClient = GithubPreviewClient;
