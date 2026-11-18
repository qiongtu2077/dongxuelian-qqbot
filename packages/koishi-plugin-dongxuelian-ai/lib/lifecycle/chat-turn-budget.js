"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatTurnBudget = exports.CHAT_TURN_LIMITS = void 0;
exports.cancelChatTurnStages = cancelChatTurnStages;
exports.runWithChatTurn = runWithChatTurn;
exports.outsideChatTurn = outsideChatTurn;
exports.currentChatTurn = currentChatTurn;
exports.assertChatTurnActive = assertChatTurnActive;
exports.sendWithChatTurn = sendWithChatTurn;
exports.delayWithSignal = delayWithSignal;
exports.waitWithSignal = waitWithSignal;
/**
 * 单轮聊天时限与取消所有权。普通明确交互从开始执行计时，随机和记录图片扣除前处理。
 * 不发送消息、不修改历史、不读取模型配置。独立后台任务必须显式退出本轮作用域。
 */
const node_async_hooks_1 = require("node:async_hooks");
const node_crypto_1 = require("node:crypto");
const model_request_context_1 = require("../core/model-request-context");
exports.CHAT_TURN_LIMITS = Object.freeze({ normal: 60000, record: 180000, randomQueue: 20000,
    forward: 10000, topic: 8000, vision: 90000, visionPrimary: 60000, visionFallback: 30000,
    textPrimary: 40000, textFallback: 30000, textFallbackExtension: 40000, normalFallbackReserve: 10000, recordFallbackReserve: 30000,
    normalSend: 3000, recordSend: 5000, cleanup: 2000 });
const turnScope = new node_async_hooks_1.AsyncLocalStorage();
const activeStages = new Map();
// --- 预算所有权 --- //
class ChatTurnBudget {
    // 建立唯一身份；不在无须聊天的入口留下计时器或全局记录。
    constructor(identity, log, validity) {
        this.identity = identity;
        this.log = log;
        this.id = (0, node_crypto_1.randomUUID)();
        this.controller = new AbortController();
        this.createdAt = Date.now();
        this.signal = this.controller.signal;
        this.recordImages = false;
        this.preprocessMs = 0;
        this.queuedAt = null;
        this.startedAt = null;
        this.deadline = Infinity;
        this.reason = '';
        this.stage = 'preprocess';
        this.finished = false;
        this.imagesRead = 0;
        this.forwardUnavailable = false;
        this.imagesTotal = 0;
        this.submittedSends = 0;
        this.pendingSends = 0;
        this.textFallbackExtended = false;
        this.work = new Set();
        this.random = identity.random === true;
        this.validity = validity;
    }
    // 档位只在正式执行前选定，随机回复永不获得记录图片预算。
    select(recordImages, random = this.random) {
        if (this.startedAt !== null)
            throw new Error('chat_turn_already_started');
        this.random = random;
        this.recordImages = recordImages && !random;
    }
    // 入队时记录前处理耗时；等待期间不会消耗执行时间或启动执行计时器。
    enqueue(validity) {
        if (this.queuedAt !== null)
            throw new Error('chat_turn_already_queued');
        this.queuedAt = Date.now();
        this.preprocessMs = this.queuedAt - this.createdAt;
        if (validity)
            this.validity = validity;
        this.event('queued');
    }
    // 正式开始只允许一次，所有后继阶段共享这一个绝对截止时间。
    start(validity) {
        if (this.startedAt !== null)
            throw new Error('chat_turn_already_started');
        const runBudget = this.remaining();
        this.startedAt = Date.now();
        if (validity)
            this.validity = validity;
        this.deadline = this.startedAt + runBudget;
        this.stage = 'running';
        this.assertActive();
        this.resetRunTimer();
        this.event('started');
    }
    // 入队前限制前处理；入队后普通明确交互保留完整执行预算。
    remaining() {
        if (this.startedAt !== null)
            return Math.max(0, this.deadline - Date.now());
        const limit = this.recordImages ? exports.CHAT_TURN_LIMITS.record : exports.CHAT_TURN_LIMITS.normal;
        if (this.queuedAt === null)
            return Math.max(0, limit - (Date.now() - this.createdAt));
        return this.random || this.recordImages ? Math.max(0, limit - this.preprocessMs) : limit;
    }
    // 首次切换普通文字备用模型时延长整轮期限，工具续轮共用这一次延期。
    extendTextFallback() {
        if (this.startedAt === null || this.random || this.recordImages || this.textFallbackExtended)
            return;
        this.assertActive();
        this.textFallbackExtended = true;
        this.deadline += exports.CHAT_TURN_LIMITS.textFallbackExtension;
        this.resetRunTimer();
        this.event('text_fallback_extended', { deadline: this.deadline, addedMs: exports.CHAT_TURN_LIMITS.textFallbackExtension });
    }
    // 更新根计时器，确保旧截止时间不会取消获准延期的轮次。
    resetRunTimer() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.cancel('run_timeout'), this.remaining());
    }
    // 在模型、工具、保存和发送前复检；计时器尚未被调度时也不能越过截止边界。
    assertActive(validity = this.validity) {
        if (!this.reason && this.remaining() <= 0)
            this.cancel('run_timeout');
        if (!this.reason && validity) {
            try {
                if (!validity())
                    this.cancel('revoked');
            }
            catch {
                this.cancel('revoked');
            }
        }
        if (this.signal.aborted)
            throw this.signal.reason;
        if (this.finished)
            throw new Error('chat_turn_finished');
    }
    // 根据是否实际存在备用节点计算预留，不读取或猜测供应商能力。
    modelBudget() {
        return { deadline: this.deadline - this.sendWindow(), primaryMs: exports.CHAT_TURN_LIMITS.textPrimary,
            fallbackMs: exports.CHAT_TURN_LIMITS.textFallback,
            fallbackReserveMs: this.recordImages ? exports.CHAT_TURN_LIMITS.recordFallbackReserve : exports.CHAT_TURN_LIMITS.normalFallbackReserve };
    }
    // 最终发送窗口属于业务总预算，不额外赠送运行时间。
    sendWindow() { return this.recordImages ? exports.CHAT_TURN_LIMITS.recordSend : exports.CHAT_TURN_LIMITS.normalSend; }
    // 阶段超时只取消子信号；根轮次取消同时终止阶段，关闭时清除监听器和计时器。
    openStage(name, maximumMs, reserveMs = 0) {
        this.assertActive();
        this.stage = name;
        const deadline = Date.now() + Math.max(0, Math.min(maximumMs, this.remaining() - reserveMs));
        const controller = new AbortController();
        const cancelTurnStage = () => controller.abort(this.signal.reason);
        this.signal.addEventListener('abort', cancelTurnStage, { once: true });
        const expire = () => controller.abort(new Error(`${name}_deadline`));
        const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
        // 入队前也观察关群和维护；运行后的有效性监视由频道队列负责。
        const monitor = this.startedAt === null && this.validity ? setInterval(() => {
            try {
                this.assertActive();
            }
            catch { /* 根信号已通知实际阶段。 */ }
        }, 250) : undefined;
        if (deadline <= Date.now())
            expire();
        this.event('stage_start', { deadline, remainingMs: deadline - Date.now() });
        let resolveExit;
        const exited = new Promise(resolve => { resolveExit = resolve; });
        const stage = { signal: controller.signal, deadline, close: () => {
                if (!activeStages.delete(stage))
                    return;
                clearTimeout(timer);
                clearInterval(monitor);
                this.signal.removeEventListener('abort', cancelTurnStage);
                controller.abort(new Error(`${name}_closed`));
                this.event('stage_end', { stage: name });
                resolveExit();
            } };
        activeStages.set(stage, { turn: this, exited });
        return stage;
    }
    // 登记当前轮次真实启动的请求，防止异步摘要或工具的外层等待先退出。
    own(promise) {
        this.work.add(promise);
        const releaseTurnWork = () => { this.work.delete(promise); };
        void promise.then(releaseTurnWork, releaseTurnWork);
        return promise;
    }
    // 清理必须等待所有已登记请求退出；不协作项由频道队列保持隔离。
    async drain() {
        while (this.work.size)
            await Promise.allSettled([...this.work]);
    }
    // 撤销正常发送资格先于通知监听器；重复取消保持第一次原因。
    cancel(reason) {
        if (this.reason || this.finished)
            return;
        this.reason = reason;
        if (this.timer)
            clearTimeout(this.timer);
        this.event('cancel');
        if (this.pendingSends)
            this.event('send_result_unknown', { pendingSends: this.pendingSends });
        this.controller.abort(new Error(`chat_turn_${reason}`));
    }
    // 只有实际业务退出后调用，清理失败时保留活所有者直到其真实退出。
    finish() {
        if (this.finished)
            return;
        this.finished = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.validity = undefined;
        this.event('finished');
    }
    // 只记录身份和时间摘要；日志故障不得影响取消与资源释放。
    event(event, detail = {}) {
        try {
            this.log?.({ event, turnId: this.id, channelKey: this.identity.channelKey, messageId: this.identity.messageId || '',
                tier: this.recordImages ? 'record_images' : 'normal', random: this.random, stage: this.stage, reason: this.reason,
                preprocessMs: this.preprocessMs, queueMs: this.queuedAt === null ? 0 : (this.startedAt ?? Date.now()) - this.queuedAt,
                runMs: this.startedAt === null ? 0 : Date.now() - this.startedAt, remainingMs: this.remaining(), ...detail });
        }
        catch { /* 诊断不干预所有权。 */ }
    }
}
exports.ChatTurnBudget = ChatTurnBudget;
// --- 调用链上下文与可取消等待 --- //
// 卸载也取消入队前阶段；观察真实退出，超出宽限仅记录，不伪造阶段已释放。
async function cancelChatTurnStages() {
    const stages = [...activeStages.entries()];
    for (const [, { turn }] of stages)
        turn.cancel('disposed');
    if (!stages.length)
        return;
    let timer;
    try {
        await Promise.race([Promise.all(stages.map(([, state]) => state.exited)),
            new Promise(resolve => { timer = setTimeout(resolve, exports.CHAT_TURN_LIMITS.cleanup); })]);
        for (const [stage, { turn }] of stages)
            if (activeStages.has(stage))
                turn.event('stage_cleanup_failed');
    }
    finally {
        clearTimeout(timer);
    }
}
// 运行明确绑定的聊天任务，使辅助模型、工具和发送共用同一身份。
function runWithChatTurn(turn, fn) { return turnScope.run(turn, () => (0, model_request_context_1.runWithModelRequestContext)(turn, fn)); }
// 正式接受的独立后台任务使用自身预算；调用前必须完成本轮有效性检查。
function outsideChatTurn(fn) { return turnScope.run(undefined, () => (0, model_request_context_1.outsideModelRequestContext)(fn)); }
// 读取当前显式任务作用域；未进入频道聊天的业务不受聊天预算影响。
function currentChatTurn() { return turnScope.getStore(); }
// 向实际业务传播取消，禁止工具续轮或迟到结果重新提交。
function assertChatTurnActive() { currentChatTurn()?.assertActive(); }
// 提交前检查资格；已提交平台发送不可撤回，等待真实结果并记录取消后的未知状态。
async function sendWithChatTurn(send) {
    const turn = currentChatTurn();
    turn?.assertActive();
    if (turn) {
        turn.stage = 'send';
        turn.submittedSends++;
        turn.pendingSends++;
        turn.event('send_start');
    }
    try {
        const result = await send();
        turn?.event('send_result', { afterCancellation: !!turn.reason });
        return result;
    }
    finally {
        if (turn)
            turn.pendingSends--;
    }
}
// 可取消的短等待在所有出口清除自身计时器和监听器。
function delayWithSignal(ms, signal) {
    return new Promise((resolve, reject) => {
        let timer;
        const cancelTurnDelay = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancelTurnDelay); reject(signal?.reason); };
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        signal?.addEventListener('abort', cancelTurnDelay, { once: true });
        timer = setTimeout(() => { signal?.removeEventListener('abort', cancelTurnDelay); resolve(); }, ms);
    });
}
// 只用于锁等候与延迟，不把取消等待冒充底层运行任务已退出。
function waitWithSignal(promise, signal) {
    return new Promise((resolve, reject) => {
        const cancelSignalWait = () => { signal.removeEventListener('abort', cancelSignalWait); reject(signal.reason); };
        if (signal.aborted) {
            promise.catch(() => { });
            cancelSignalWait();
            return;
        }
        signal.addEventListener('abort', cancelSignalWait, { once: true });
        promise.then(value => { signal.removeEventListener('abort', cancelSignalWait); resolve(value); }, error => { signal.removeEventListener('abort', cancelSignalWait); reject(error); });
    });
}
