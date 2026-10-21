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
// Only keep display and identity metadata; issue/PR bodies never enter caches.
function selectGithubFields(raw) {
    const fields = ['full_name', 'name', 'login', 'html_url', 'private', 'description', 'language', 'stargazers_count', 'forks_count', 'archived', 'updated_at', 'license', 'type', 'bio', 'avatar_url', 'public_repos', 'followers', 'following', 'created_at', 'title', 'number', 'state', 'merged', 'draft', 'pull_request', 'labels'];
    const result = {};
    for (const field of fields)
        if (raw[field] !== undefined)
            result[field] = raw[field];
    if (raw.user) {
        const user = githubObject(raw.user, 'user');
        result.user = { login: user.login, avatar_url: user.avatar_url };
    }
    return result;
}
// Consume a bounded JSON response with the same request cancellation signal.
async function readGithubJson(response) {
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
        return githubObject(JSON.parse(Buffer.concat(chunks).toString('utf8')), 'response');
    }
    catch (error) {
        if (error instanceof GithubQueryError)
            throw error;
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
    async request(route, context) {
        const job = this.serial.catch(() => { }).then(() => this.requestSerial(route, context));
        this.serial = job;
        return job;
    }
    // Revalidate metadata using ETag; enforce rate limits, bounded retries and safe redirects.
    async requestSerial(route, context) {
        (0, models_1.assertGithubWork)(context);
        const cached = this.cache.get(route);
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
                        response = await this.transport(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'LianLianBot-GitHub-Preview', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}), ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}) } });
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
            if (response.status === 304 && cached?.value) {
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
                    this.remember(route, { missing: true, fetchedAt: Date.now(), checkedAt: Date.now() });
                const message = rateLimited ? 'GitHub 请求受限，请稍后重试' : { 401: 'GitHub 认证配置不可用', 403: 'GitHub 拒绝访问', 404: '资源不存在或当前不可访问', 410: '资源已移除' }[status] || 'GitHub 服务请求失败';
                throw new GithubQueryError(message, status, rateLimited || status >= 500);
            }
            const value = selectGithubFields(await readGithubJson(response));
            const entry = { value, etag: response.headers.get('etag') || undefined, fetchedAt: Date.now(), checkedAt: Date.now() };
            this.remember(route, entry);
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
    // Keep the metadata cache bounded without retaining body text or credentials.
    remember(route, value) {
        this.cache.delete(route);
        this.cache.set(route, value);
        while (this.cache.size > models_1.GITHUB_LIMITS.cacheEntries)
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
        const metadata = { target: canonical, title: '', url, fetchedAt: entry.fetchedAt, facts: [] };
        if (target.kind === 'user') {
            metadata.title = githubString(value, 'name', true) || githubString(value, 'login');
            metadata.description = githubString(value, 'bio', true);
            metadata.avatar = githubString(value, 'avatar_url');
            metadata.facts = [['账户', githubString(value, 'type') === 'Organization' ? '组织账户' : '用户'], ['登录名', githubString(value, 'login')], ['公开仓库', githubCount(value, 'public_repos')], ['关注者（公开可见）', githubCount(value, 'followers')], ['关注中（公开可见）', githubCount(value, 'following')], ['注册时间', githubString(value, 'created_at')]];
        }
        else if (target.kind === 'repository') {
            metadata.title = githubString(value, 'full_name');
            metadata.description = githubString(value, 'description', true);
            const license = value.license === null ? null : githubObject(value.license, 'license');
            metadata.facts = [['主要语言', githubString(value, 'language', true) || '未提供'], ['Stars', githubCount(value, 'stargazers_count')], ['Forks', githubCount(value, 'forks_count')], ['许可证', license ? githubString(license, 'name') : '未提供'], ['更新时间', githubString(value, 'updated_at')]];
            if (value.archived === true)
                metadata.facts.push(['归档', '已归档']);
        }
        else {
            metadata.title = githubString(value, 'title');
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
        }
        return metadata;
    }
}
exports.GithubPreviewClient = GithubPreviewClient;
