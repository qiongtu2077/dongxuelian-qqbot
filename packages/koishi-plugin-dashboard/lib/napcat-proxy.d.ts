interface NapcatProxyOptions {
    token?: string;
}
declare function napcatProxy(req: any, res: any, targetPath: any, getStatusFn: any, options?: NapcatProxyOptions): void;
declare const _default: {
    napcatProxy: typeof napcatProxy;
};
export = _default;
