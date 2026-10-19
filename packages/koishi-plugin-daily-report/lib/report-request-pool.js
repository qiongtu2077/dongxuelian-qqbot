"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReportRequestPool = exports.ReportRequestBoundaryError = void 0;
// 已知请求边界错误必须停止相应调用，不能被当成模型格式问题再消耗恢复。
class ReportRequestBoundaryError extends Error {
    // 明确区分上游不可用、额度和执行契约；保留原始原因文字。
    constructor(kind, message, upstreamFailure = null) {
        super(message);
        this.kind = kind;
        this.name = 'ReportRequestBoundaryError';
        this.upstreamFailure = upstreamFailure ? Object.freeze({ ...upstreamFailure }) : null;
    }
}
exports.ReportRequestBoundaryError = ReportRequestBoundaryError;
class ReportRequestPool {
    // 限制由调用方已核实的资源准入决定，只允许方案规定的一路或两路。
    constructor(limit) {
        this.limit = limit;
        this.active = 0;
        this.waiting = [];
        this.idle = [];
        if (limit !== 1 && limit !== 2)
            throw new Error('日报实际请求并发只能一或二');
    }
    // 槽位包住实际请求Promise，不因外层超时竞速提前释放。
    async run(signal, action) {
        await this.acquire(signal);
        try {
            if (signal.aborted)
                throw signal.reason || new Error('日报请求已取消');
            return await action();
        }
        finally {
            this.release();
        }
    }
    // 所有真实请求完成清理后才允许上层释放任务资源。
    async drain() {
        if (!this.active && !this.waiting.length)
            return;
        await new Promise(resolve => this.idle.push(resolve));
    }
    // 公平领取请求槽；未提交的等待请求被取消时直接移除。
    async acquire(signal) {
        if (signal.aborted)
            throw signal.reason || new Error('日报请求已取消');
        if (this.active < this.limit && !this.waiting.length) {
            this.active++;
            return;
        }
        await new Promise((resolve, reject) => {
            const entry = { resolve, reject, signal, onAbort: () => {
                    const index = this.waiting.indexOf(entry);
                    if (index >= 0)
                        this.waiting.splice(index, 1);
                    signal.removeEventListener('abort', entry.onAbort);
                    reject(signal.reason || new Error('日报等待请求已取消'));
                    this.notifyIdle();
                } };
            this.waiting.push(entry);
            signal.addEventListener('abort', entry.onAbort, { once: true });
        });
    }
    // 实际Promise结束后移交槽位；已取消等待者不获得执行机会。
    release() {
        this.active--;
        while (this.waiting.length && this.active < this.limit) {
            const entry = this.waiting.shift();
            entry.signal.removeEventListener('abort', entry.onAbort);
            if (entry.signal.aborted) {
                entry.reject(entry.signal.reason || new Error('日报等待请求已取消'));
                continue;
            }
            this.active++;
            entry.resolve();
        }
        this.notifyIdle();
    }
    // 清空实际请求及等待者后唤醒任务清理，不伪造上游已经结束。
    notifyIdle() {
        if (!this.active && !this.waiting.length)
            this.idle.splice(0).forEach(resolve => resolve());
    }
}
exports.ReportRequestPool = ReportRequestPool;
