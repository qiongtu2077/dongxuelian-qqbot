/**
 * MODULE: S5 模式状态。
 * 职责: 从 S1 快照读取当前 Bot 模式和资源档位。
 * 边界: 不保存模式队列，不覆盖 S1/S0 状态。
 */
interface BotModeStateSnapshot {
    resourceState: string;
    botMode: string;
    memAvailableMb: number | null;
    memTotalMb?: number | null;
    memSource?: string;
    locked?: boolean;
    running?: unknown | null;
    maintenance?: boolean;
    createdAt?: string;
}
declare function readBotModeState(): BotModeStateSnapshot;
declare const _default: {
    readBotModeState: typeof readBotModeState;
};
export = _default;
