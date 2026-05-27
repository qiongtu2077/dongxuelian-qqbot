/**
 * MODULE: 精确计算工具。
 * 安全：只允许数字、运算符、括号和 Math 函数，拒绝任意代码执行。
 */
interface CalculateToolParams {
    expression?: unknown;
}
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                expression: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: CalculateToolParams): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
