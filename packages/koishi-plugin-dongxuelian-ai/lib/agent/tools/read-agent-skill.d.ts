/**
 * MODULE: Agent Skill 读取工具。
 * 职责: 读取已登记 Skill 的入口文档或同目录参考文件。
 * 边界: 不读取任意本地文件、不执行 Skill、不修改配置。
 * 状态: 无。
 */
interface ReadAgentSkillParams {
    name?: unknown;
    file?: unknown;
    maxChars?: unknown;
}
interface ReadAgentSkillContext {
    channel?: string;
    autoRelevantSkill?: boolean;
    userMessage?: string;
}
declare const _default: {
    definition: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                name: {
                    type: string;
                    description: string;
                };
                file: {
                    type: string;
                    description: string;
                };
                maxChars: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    execute(params?: ReadAgentSkillParams, context?: ReadAgentSkillContext): Promise<string>;
    dangerous: boolean;
    defaultChannels: string[];
};
export = _default;
