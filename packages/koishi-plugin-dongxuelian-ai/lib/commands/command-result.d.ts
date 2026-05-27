/**
 * MODULE: 命令处理结果封装。
 * 边界: 不读取配置、不访问 session、不调 AI API、不修改 conversation。
 * 状态: 无运行时状态。
 */
declare function handled(response?: unknown): {
    matched: true;
    response?: unknown;
};
declare function notHandled(): {
    matched: false;
};
declare const _default: {
    handled: typeof handled;
    notHandled: typeof notHandled;
};
export = _default;
