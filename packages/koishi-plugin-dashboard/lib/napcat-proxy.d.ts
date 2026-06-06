import type { IncomingMessage, ServerResponse } from 'http';
interface NapcatProxyOptions {
    token?: string;
}
interface NapcatStatus {
    logLines?: string[];
    login?: {
        reason?: string;
    };
    installation?: {
        reason?: string;
    };
}
type GetNapcatStatus = () => NapcatStatus;
declare function napcatProxy(req: IncomingMessage, res: ServerResponse, targetPath: string, getStatusFn?: GetNapcatStatus | null, options?: NapcatProxyOptions): void;
declare const _default: {
    napcatProxy: typeof napcatProxy;
};
export = _default;
