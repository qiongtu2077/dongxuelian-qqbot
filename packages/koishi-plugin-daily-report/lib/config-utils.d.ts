/**
 * MODULE: daily-report configuration helpers.
 * 职责: 统一解析日报环境变量中的有界数值。
 * 边界: 不读取环境变量、不决定各调用方的默认值和范围。
 */
export declare function parseBoundedInt(value: string | undefined, fallback: number, min: number, max: number): number;
