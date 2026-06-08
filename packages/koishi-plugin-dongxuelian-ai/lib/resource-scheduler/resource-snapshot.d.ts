type ResourceState = 'green' | 'yellow' | 'red' | 'black';
type BotMode = 'normal' | 'busy' | 'report_silent' | 'critical' | 'maintenance';
interface ResourceSnapshot {
    resourceState: ResourceState;
    botMode: BotMode;
    memAvailableMb: number | null;
    memTotalMb: number | null;
    memSource: string;
    locked: boolean;
    running: unknown | null;
    maintenance: boolean;
    createdAt: string;
}
interface MemorySnapshot {
    availableMb: number | null;
    totalMb: number | null;
    source: string;
}
declare function readMeminfoOverride(): {
    availableMb: number | null;
    totalMb: number | null;
} | null;
declare function readCgroupV2Meminfo(): MemorySnapshot | null;
declare function readProcMeminfo(): MemorySnapshot;
declare function readLinuxMeminfo(): MemorySnapshot;
declare function classifyResourceState(memAvailableMb: number | null): ResourceState;
declare function classifyBotMode(resourceState: ResourceState, running: unknown, maintenance: boolean): BotMode;
declare function readResourceSnapshot(): ResourceSnapshot;
declare const _default: {
    SCHEDULER_ROOT: string;
    SCHEDULER_STATE_FILE: string;
    GREEN_MEM_AVAILABLE_MB: number;
    YELLOW_MEM_AVAILABLE_MB: number;
    RED_MEM_AVAILABLE_MB: number;
    readMeminfoOverride: typeof readMeminfoOverride;
    readCgroupV2Meminfo: typeof readCgroupV2Meminfo;
    readProcMeminfo: typeof readProcMeminfo;
    readLinuxMeminfo: typeof readLinuxMeminfo;
    classifyResourceState: typeof classifyResourceState;
    classifyBotMode: typeof classifyBotMode;
    readResourceSnapshot: typeof readResourceSnapshot;
};
export = _default;
