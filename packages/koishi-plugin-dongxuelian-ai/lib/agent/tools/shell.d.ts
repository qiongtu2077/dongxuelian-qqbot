interface ShellParams {
    command?: unknown;
    cwd?: unknown;
}
type ShellEnv = Record<string, string>;
declare function buildSafeShellEnv(source?: NodeJS.ProcessEnv): ShellEnv;
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                command: {
                    type: string;
                    description: string;
                };
                cwd: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: ShellParams): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
    buildSafeShellEnv: typeof buildSafeShellEnv;
};
export = _default;
