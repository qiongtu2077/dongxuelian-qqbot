/**
 * MODULE: 自定义 OpenAI 兼容模型的四能力探测。
 * 职责: 以小型有效请求验证既有运行时协议，返回脱敏的三态检测结果。
 * 边界: 不保存配置、不记录认证头；不跟随重定向；全局最多两个探测请求。
 * 状态: active/waiters 只管理进程内请求并发，每个请求单独超时并释放槽位。
 */
import type { ManagementModule } from 'koishi-plugin-dongxuelian-ai/lib/public/management-runtime';
type Model = ReturnType<ManagementModule<'core.aiCapabilityConfig'>['normalizeDiscoveredModels']>[number];
type Capability = 'text' | 'vision' | 'voice-asr' | 'voice-tts';
type Check = {
    status: 'supported' | 'unsupported' | 'pending';
    reason: string;
};
declare function inspectResponse(response: Response, capability: Capability): Promise<Check>;
declare function detectModelCapabilities(baseURL: string, model: Model, key: string): Promise<Model>;
declare const _default: {
    detectModelCapabilities: typeof detectModelCapabilities;
    inspectResponse: typeof inspectResponse;
};
export = _default;
