type ServerMode = 'small' | 'large';
interface ServerModeState {
    serverMode: ServerMode;
    serverModeSource: string;
}
interface BackgroundAllowedInput {
    serverMode?: unknown;
    resourceState?: unknown;
    maintenance?: unknown;
    toolActive?: unknown;
    renderActive?: unknown;
}
interface BackgroundAllowedState extends ServerModeState {
    backgroundAllowed: boolean;
}
interface ResourceActivityMutualExclusionState extends ServerModeState {
    strictActivityMutualExclusion: boolean;
}
declare function normalizeServerMode(value: unknown): ServerMode;
declare function readServerModeConfig(): ServerModeState;
declare function writeServerModeConfig(serverMode: unknown, meta?: Record<string, unknown>): ServerModeState;
declare function resolveBackgroundAllowed(input?: BackgroundAllowedInput): boolean;
declare function readServerModeState(input?: BackgroundAllowedInput): BackgroundAllowedState;
declare function readResourceActivityMutualExclusionState(serverMode?: unknown): ResourceActivityMutualExclusionState;
declare const _default: {
    SERVER_MODE_CONTROL_DIR: string;
    SERVER_MODE_CONFIG_FILE: string;
    DEFAULT_SERVER_MODE: "large";
    normalizeServerMode: typeof normalizeServerMode;
    readServerModeConfig: typeof readServerModeConfig;
    writeServerModeConfig: typeof writeServerModeConfig;
    resolveBackgroundAllowed: typeof resolveBackgroundAllowed;
    readServerModeState: typeof readServerModeState;
    readResourceActivityMutualExclusionState: typeof readResourceActivityMutualExclusionState;
};
export = _default;
