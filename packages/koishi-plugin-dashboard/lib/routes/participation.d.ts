/** 参与开关管理：管理员鉴权、首次启用默认值和多文件原子事务。 */
import type { IncomingMessage, ServerResponse } from 'http';
declare function handleGetParticipation(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutParticipation(req: IncomingMessage, res: ServerResponse): void;
export declare const routes: {
    'GET /dashboard/api/participation': typeof handleGetParticipation;
    'PUT /dashboard/api/participation': typeof handlePutParticipation;
};
export {};
