declare function waitForNapcatWebui(port: number, timeoutMs?: number): Promise<void>;
declare function waitForKoishiOnebot(koishiDir: string, onebotPort: number, timeoutMs?: number): Promise<void>;
declare function restartNapcatService(serviceName: string, port: number, koishiDir: string, onebotPort: number): Promise<{
    botReconnected: boolean;
}>;
declare const _default: {
    restartNapcatService: typeof restartNapcatService;
    waitForNapcatWebui: typeof waitForNapcatWebui;
    waitForKoishiOnebot: typeof waitForKoishiOnebot;
};
export = _default;
