interface BridgeResponse {
    type?: 'response';
    id?: unknown;
    success: boolean;
    payload?: Record<string, unknown>;
    error?: string;
}
declare function handleMessage(input: unknown): Promise<BridgeResponse>;
declare const _default: {
    handleMessage: typeof handleMessage;
};
export = _default;
