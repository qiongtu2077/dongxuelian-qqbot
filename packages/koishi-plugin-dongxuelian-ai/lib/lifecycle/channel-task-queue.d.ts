interface QueueOptions {
    ctx?: unknown;
    maxQueueAgeMs?: number | string;
}
declare function enqueueForChannel(channelKey: string, fn: () => Promise<unknown> | unknown, maxDepth: number, options?: QueueOptions): boolean;
declare function clearChannelQueues(): void;
declare const _default: {
    enqueueForChannel: typeof enqueueForChannel;
    clearChannelQueues: typeof clearChannelQueues;
};
export = _default;
