import type { IncomingMessage, ServerResponse } from 'http';
interface LegacyNapcatStatus {
    running: boolean;
    login: 'online' | 'waiting-login' | 'offline';
    webui: boolean;
    onebot: boolean;
    webuiPort: number;
    onebotPort: number;
    qqExecutable: string;
    processes: string[];
}
type RouteHandler = (req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) => unknown;
declare function stopKoishiProcesses(): void;
declare function getLegacyNapcatStatus(): LegacyNapcatStatus;
declare function readKoishiSelfId(): string;
declare function resolveNapcatRestartQq(): string;
declare const _default: {
    routes: Record<string, RouteHandler>;
    resolveKoishiListenPort: () => number;
    stopKoishiProcesses: typeof stopKoishiProcesses;
    getLegacyNapcatStatus: typeof getLegacyNapcatStatus;
    readKoishiSelfId: typeof readKoishiSelfId;
    resolveNapcatRestartQq: typeof resolveNapcatRestartQq;
    readLoggingConfig: () => unknown;
    writeLoggingConfig: (config: unknown) => {
        enabled?: boolean;
    };
};
export = _default;
