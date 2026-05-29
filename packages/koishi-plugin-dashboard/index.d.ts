declare function apply(ctx: any): void;
declare const _default: {
    name: string;
    apply: typeof apply;
    FEATURES_DATA: {
        id: string;
        title: string;
        summary: string;
        detail: string;
        usage: string;
        related: string[];
    }[];
    COMMANDS_DATA: {
        category: string;
        commands: {
            cmd: string;
            desc: string;
        }[];
    }[];
};
export = _default;
