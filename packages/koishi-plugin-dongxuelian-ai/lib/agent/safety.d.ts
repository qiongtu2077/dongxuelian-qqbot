type SafetyMode = 'auto' | 'confirm' | 'block' | 'config';
type EffectiveSafetyPolicy = Exclude<SafetyMode, 'config'>;
interface SafetyCheckResult {
    allowed: boolean;
    action?: EffectiveSafetyPolicy;
    error?: string;
}
declare function getMode(): SafetyMode;
declare function setMode(m: unknown): Promise<void>;
declare function getEffectivePolicy(): EffectiveSafetyPolicy;
declare function check(toolName: unknown): SafetyCheckResult;
declare const _default: {
    getMode: typeof getMode;
    setMode: typeof setMode;
    getEffectivePolicy: typeof getEffectivePolicy;
    check: typeof check;
    DANGEROUS_TOOLS: Set<string>;
};
export = _default;
