type TopicSwitchResult = boolean | null;
interface TopicSwitchSessionLike {
    guildId?: string;
    channelId?: string;
    isDirect?: boolean;
    userId?: string;
    username?: string;
    messageId?: string;
    selfId?: string;
    author?: {
        id?: string;
    };
    bot?: {
        selfId?: string;
    };
}
interface TopicSwitchOptions {
    topicKey?: string;
    session?: TopicSwitchSessionLike;
    currentText?: string;
}
declare function detectTopicSwitch(lastMsg: string, currentMsg: string): Promise<TopicSwitchResult>;
declare function resolveTopicSwitch({ topicKey, session, currentText }?: TopicSwitchOptions): Promise<TopicSwitchResult>;
declare function clearTopicSwitchLocks(): void;
declare const _default: {
    detectTopicSwitch: typeof detectTopicSwitch;
    resolveTopicSwitch: typeof resolveTopicSwitch;
    clearTopicSwitchLocks: typeof clearTopicSwitchLocks;
};
export = _default;
