export type Protocol = 'napcat' | 'sl';
export declare const selectionFile: string;
export declare const slRoot: string;
/** 执行固定参数的服务命令，保留 systemd 的原始失败原因。 */
export declare function systemctl(...args: string[]): Promise<string>;
/** 读取唯一协议选择；缺失时沿用既有 NapCat，损坏时拒绝启动。 */
export declare function selectedProtocol(): Protocol;
/** 读取服务状态及控制组，必须确认进程组已清空后才允许启动另一协议。 */
export declare function serviceState(unit: string): Promise<{
    state: string;
    pid: number;
}>;
/** 查询两个受管实例的真实状态，不把其他项目 QQ 实例算进来。 */
export declare function protocolStatus(): Promise<{
    supported: boolean;
    selected: Protocol;
    switching: boolean;
    napcat?: undefined;
    sl?: undefined;
    conflict?: undefined;
    installed?: undefined;
} | {
    supported: boolean;
    selected: Protocol;
    switching: boolean;
    napcat: {
        state: string;
        pid: number;
    };
    sl: {
        state: string;
        pid: number;
    };
    conflict: boolean;
    installed: boolean;
}>;
/** 将切换与登录重连放在同一个跨进程排他区间，避免两个请求相互覆盖。 */
export declare function withProtocolLock<T>(operation: () => Promise<T>): Promise<T>;
/** 串行切换协议，目标启动失败时先停目标再恢复旧选择和原先运行的服务。 */
export declare function switchProtocol(provider: Protocol): Promise<{
    switching: boolean;
    supported: boolean;
    selected: Protocol;
    napcat?: undefined;
    sl?: undefined;
    conflict?: undefined;
    installed?: undefined;
} | {
    switching: boolean;
    supported: boolean;
    selected: Protocol;
    napcat: {
        state: string;
        pid: number;
    };
    sl: {
        state: string;
        pid: number;
    };
    conflict: boolean;
    installed: boolean;
}>;
/** 旧 NapCat 启动入口必须服从同一选择，避免绕过顶部菜单。 */
export declare function assertNapcatSelected(): void;
/** 将当前实例数据路径提供给登录适配，避免读取另一个项目。 */
export declare const koishiDir: string;
