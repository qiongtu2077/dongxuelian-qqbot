interface StatusSession {
    isDirect?: boolean;
    guildId?: string;
    channelId?: string;
    userId?: string;
    selfId?: string;
    bot?: {
        selfId?: string;
        internal?: {
            sendGroupForwardMsg?: (id: string, nodes: unknown[]) => unknown | Promise<unknown>;
            sendPrivateForwardMsg?: (id: string, nodes: unknown[]) => unknown | Promise<unknown>;
        };
    };
}
declare function buildResourceStatusReply(checkConnectivity?: boolean, channelKey?: string): Promise<string>;
declare function buildStatusCommandReply(session: StatusSession, checkConnectivity?: boolean): Promise<string | undefined>;
declare const _default: {
    buildResourceStatusReply: typeof buildResourceStatusReply;
    buildStatusCommandReply: typeof buildStatusCommandReply;
};
export = _default;
