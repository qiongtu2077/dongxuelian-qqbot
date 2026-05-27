interface AnalyzedMessage {
    memory?: string;
    plain?: string;
    hasAudio?: boolean;
    hasFile?: boolean;
    hasMessageRecordCue?: boolean;
}
declare function resolveSharedRecordText(plain: string, analyzed?: AnalyzedMessage): string;
declare const _default: {
    resolveSharedRecordText: typeof resolveSharedRecordText;
};
export = _default;
