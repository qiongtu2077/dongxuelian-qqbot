/** 参与开关管理：管理员鉴权、首次启用默认值和多文件原子事务。 */
import type { IncomingMessage, ServerResponse } from 'http';
declare function handleManageGroup(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetGroupSettings(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutGroupSettings(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetParticipation(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetGroupNames(req: IncomingMessage, res: ServerResponse): void;
declare function handleImportGroupNames(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutGroupName(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutParticipation(req: IncomingMessage, res: ServerResponse): void;
export declare const routes: {
    'GET /dashboard/api/groups': typeof handleGetGroupNames;
    'POST /dashboard/api/groups': typeof handleManageGroup;
    'DELETE /dashboard/api/groups': typeof handleManageGroup;
    'GET /dashboard/api/groups/detail': typeof handleGetGroupSettings;
    'PUT /dashboard/api/groups/detail': typeof handlePutGroupSettings;
    'POST /dashboard/api/groups/import': typeof handleImportGroupNames;
    'PUT /dashboard/api/groups': typeof handlePutGroupName;
    'GET /dashboard/api/participation': typeof handleGetParticipation;
    'PUT /dashboard/api/participation': typeof handlePutParticipation;
};
export {};
