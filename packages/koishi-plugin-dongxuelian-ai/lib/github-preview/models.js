"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GITHUB_LIMITS = void 0;
exports.assertGithubWork = assertGithubWork;
exports.waitGithubWork = waitGithubWork;
exports.GITHUB_LIMITS = Object.freeze({
    loadMs: 25000, captureMs: 5000, runMs: 45000, queueMs: 15000, maxQueued: 20,
    maxTargets: 3, cooldownMs: 120000, cacheMs: 300000, staleMs: 1800000,
    cacheEntries: 100, cacheBytes: 20 * 1024 * 1024, imageBytes: 10 * 1024 * 1024,
    padding: 24, imageHeight: 2000, maxImages: 3, viewportWidth: 1280,
    minMemoryMb: 650, stopMemoryMb: 350,
});
// Stop immediately after cancellation or the shared task deadline.
function assertGithubWork(context) {
    context.signal.throwIfAborted();
    if (Date.now() >= context.deadline)
        throw new Error('GitHub 查询处理超时');
}
// Wait for a short bounded stage and release its abort listener on every path.
function waitGithubWork(ms, signal) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const abortGithubWait = () => { clearTimeout(timer); reject(signal.reason); signal.removeEventListener('abort', abortGithubWait); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abortGithubWait); resolve(); }, ms);
        signal.addEventListener('abort', abortGithubWait, { once: true });
    });
}
