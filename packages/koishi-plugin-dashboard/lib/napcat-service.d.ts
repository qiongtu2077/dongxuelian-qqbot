declare function waitForNapcatWebui(port: number, timeoutMs?: number): Promise<void>;
declare function restartNapcatService(serviceName: string, port: number): Promise<void>;
declare const _default: {
    restartNapcatService: typeof restartNapcatService;
    waitForNapcatWebui: typeof waitForNapcatWebui;
};
export = _default;
