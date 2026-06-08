import type { IncomingMessage, ServerResponse } from 'http';
type RegexRouteHandler = (req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray, pathname: string, url: URL) => unknown;
interface RegexRoute {
    pattern: RegExp;
    method: string;
    handler: RegexRouteHandler;
}
declare function handleGetWhitelist(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutWhitelist(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetKeys(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetKeysUsage(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutKeys(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetCustomProviders(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutCustomProviders(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetFallback(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutFallback(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetFeatures(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetCommands(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetAdminIds(req: IncomingMessage, res: ServerResponse): void;
declare function handlePutAdminIds(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetTools(req: IncomingMessage, res: ServerResponse): void;
declare function handleGetToolsPending(req: IncomingMessage, res: ServerResponse): void;
declare const _default: {
    routes: {
        'GET /dashboard/api/whitelist': typeof handleGetWhitelist;
        'PUT /dashboard/api/whitelist': typeof handlePutWhitelist;
        'GET /dashboard/api/keys': typeof handleGetKeys;
        'GET /dashboard/api/keys/usage': typeof handleGetKeysUsage;
        'PUT /dashboard/api/keys': typeof handlePutKeys;
        'GET /dashboard/api/providers/custom': typeof handleGetCustomProviders;
        'PUT /dashboard/api/providers/custom': typeof handlePutCustomProviders;
        'GET /dashboard/api/fallback': typeof handleGetFallback;
        'PUT /dashboard/api/fallback': typeof handlePutFallback;
        'GET /dashboard/api/features': typeof handleGetFeatures;
        'GET /dashboard/api/commands': typeof handleGetCommands;
        'GET /dashboard/api/admin-ids': typeof handleGetAdminIds;
        'PUT /dashboard/api/admin-ids': typeof handlePutAdminIds;
        'GET /dashboard/api/tools': typeof handleGetTools;
        'GET /dashboard/api/tools/pending': typeof handleGetToolsPending;
    };
    regexRoutes: RegexRoute[];
};
export = _default;
