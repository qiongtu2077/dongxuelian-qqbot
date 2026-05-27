/**
 * MODULE: Shell 命令安全守卫。
 * 职责: 对 execute_shell 命令进行多层安全检查，移植自 QwenPaw ToolGuard 全部规则。
 * 边界: 不执行命令，只返回违规列表。
 * 状态: 无运行时状态（纯函数）。
 */
type ShellGuardSeverity = 'high' | 'critical';
interface ShellGuardRule {
    id: string;
    re: RegExp;
    sev: ShellGuardSeverity;
    desc: string;
}
interface ShellGuardViolation {
    id: string;
    severity: ShellGuardSeverity;
    description: string;
    category: string;
}
interface ShellGuardResult {
    violations: ShellGuardViolation[];
    blocked: boolean;
    summary: string;
}
interface ShellGuardCategoryInfo {
    category: string;
    label: string;
    description: string;
    count: number;
    rules: Array<{
        id: string;
        severity: ShellGuardSeverity;
        description: string;
    }>;
}
/**
 * 对 shell 命令执行完整安全检查
 * @param {string} command - 要执行的 shell 命令
 * @returns {{ violations: Array, blocked: boolean, summary: string }}
 */
declare function checkShellCommand(command: string): ShellGuardResult;
/**
 * 快速判断命令是否包含任何危险模式
 */
declare function isCommandSafe(command: string): boolean;
declare function listShellGuardRules(): ShellGuardCategoryInfo[];
declare function summarizeShellCommand(command?: string, max?: number): string;
declare const _default: {
    checkShellCommand: typeof checkShellCommand;
    isCommandSafe: typeof isCommandSafe;
    ALL_REGEX_RULES: ShellGuardRule[];
    listShellGuardRules: typeof listShellGuardRules;
    summarizeShellCommand: typeof summarizeShellCommand;
    categories: {
        DATA_DESTRUCTION: ShellGuardRule[];
        SYSTEM_DESTRUCTION: ShellGuardRule[];
        CODE_EXECUTION: ShellGuardRule[];
        NETWORK_ABUSE: ShellGuardRule[];
        SENSITIVE_FILE: ShellGuardRule[];
        PRIVILEGE_ESCALATION: ShellGuardRule[];
        SHELL_EVASION: ShellGuardRule[];
    };
};
export = _default;
