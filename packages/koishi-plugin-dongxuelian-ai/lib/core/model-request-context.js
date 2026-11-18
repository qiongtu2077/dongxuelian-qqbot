"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWithModelRequestContext = runWithModelRequestContext;
exports.outsideModelRequestContext = outsideModelRequestContext;
exports.currentModelRequestContext = currentModelRequestContext;
/** 类型化模型请求上下文；底层 API 只依赖此契约，不反向加载聊天生命周期。 */
const node_async_hooks_1 = require("node:async_hooks");
const modelRequestScope = new node_async_hooks_1.AsyncLocalStorage();
// 业务入口显式提供预算与所有权；协议层无需知道队列和会话结构。
function runWithModelRequestContext(context, fn) { return modelRequestScope.run(context, fn); }
// 独立后台任务和既有故障通知退出前台请求预算。
function outsideModelRequestContext(fn) { return modelRequestScope.run(undefined, fn); }
// 不处于聊天轮次的调用继续使用自身原有预算。
function currentModelRequestContext() { return modelRequestScope.getStore(); }
