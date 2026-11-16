type RecordData = Record<string, unknown>;
/** 切换或重启后丢弃旧运行时的会话令牌。 */
export declare function clearSlSession(): void;
/** 返回协议文本和真实会话；协议确认前不请求受限的会话接口。 */
export declare function slLoginState(): Promise<{
    agreements: RecordData;
    accounts: unknown;
    processes: RecordData[];
}>;
/** 仅在用户明确点击同意后记录当前版本的官方协议。 */
export declare function acceptSlAgreements(version: string): Promise<RecordData>;
/** 核实 PID 指向独立 SL 目录的 QQ，拒绝接入同服务器的其他 QQ 实例。 */
export declare function readSlQqPid(): number;
/** 从现有 Koishi 配置读取唯一 OneBot 正向连接，保留账号、路径和 Token。 */
export declare function readOnebotTarget(): {
    selfId: string;
    endpoint: URL;
    token: string;
};
/** 接入自己的 QQ 进程，账号匹配后配置 OneBot 并验证 Koishi 的实际连接。 */
export declare function connectSlAccount(): Promise<{
    connected: boolean;
    message: string;
}>;
export {};
