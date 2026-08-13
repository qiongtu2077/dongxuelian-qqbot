interface BrowserActionParams {
    action?: unknown;
    url?: unknown;
    selector?: unknown;
    targetSelector?: unknown;
    text?: unknown;
    key?: unknown;
    attribute?: unknown;
    value?: unknown;
    name?: unknown;
    index?: unknown;
    width?: unknown;
    height?: unknown;
    x?: unknown;
    y?: unknown;
    query?: unknown;
    limit?: unknown;
    timeoutMs?: unknown;
    code?: unknown;
    steps?: unknown;
    fields?: unknown;
    path?: unknown;
    paths?: unknown;
    file?: unknown;
    fullPage?: unknown;
    printBackground?: unknown;
    landscape?: unknown;
}
interface BrowserActionContext {
    userId?: string;
    channelKey?: string;
    taskId?: unknown;
    resourceTaskId?: unknown;
}
declare function assertEnoughMemoryForBrowser(): void;
declare function validateUrl(raw: unknown): Promise<string>;
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                action: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                url: {
                    type: string;
                    description: string;
                };
                selector: {
                    type: string;
                    description: string;
                };
                targetSelector: {
                    type: string;
                    description: string;
                };
                text: {
                    type: string;
                    description: string;
                };
                key: {
                    type: string;
                    description: string;
                };
                attribute: {
                    type: string;
                    description: string;
                };
                value: {
                    type: string;
                    description: string;
                };
                name: {
                    type: string;
                    description: string;
                };
                index: {
                    type: string;
                    description: string;
                };
                width: {
                    type: string;
                    description: string;
                };
                height: {
                    type: string;
                    description: string;
                };
                x: {
                    type: string;
                    description: string;
                };
                y: {
                    type: string;
                    description: string;
                };
                query: {
                    type: string;
                    description: string;
                };
                limit: {
                    type: string;
                    description: string;
                };
                timeoutMs: {
                    type: string;
                    description: string;
                };
                code: {
                    type: string;
                    description: string;
                };
                steps: {
                    type: string;
                    description: string;
                };
                fields: {
                    type: string;
                    description: string;
                };
                path: {
                    type: string;
                    description: string;
                };
                paths: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: BrowserActionParams, context?: BrowserActionContext): Promise<string>;
    validateUrl: typeof validateUrl;
    isPrivateIp: (ip?: unknown) => boolean;
    isPrivateHostname: (hostname?: unknown) => boolean;
    BROWSER_MIN_AVAILABLE_MB: number;
    assertEnoughMemoryForBrowser: typeof assertEnoughMemoryForBrowser;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
