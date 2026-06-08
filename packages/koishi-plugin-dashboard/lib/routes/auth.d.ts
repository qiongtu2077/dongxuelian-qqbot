import type { IncomingMessage, ServerResponse } from 'http';
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;
type AuthMiddleware = (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean;
declare const _default: {
    routes: Record<string, RouteHandler>;
    authMiddleware: AuthMiddleware;
};
export = _default;
