/**
 * MODULE: 日报明确对象交换的共用合法性检查。
 * 职责: 拒绝不确定字段及JSON重复键。
 * 边界: 不请求模型、不处理覆盖或修改原话；重复键检查只接已经成功解析的JSON。
 * 状态: 无全局状态。
 */
export declare function assertReportFields(value: unknown, names: string[], label: string): asserts value is Record<string, unknown>;
export declare function assertReportDisplayText(text: string, references: Iterable<string>, label: string): void;
export declare function assertReportObjectKeys(text: string): void;
