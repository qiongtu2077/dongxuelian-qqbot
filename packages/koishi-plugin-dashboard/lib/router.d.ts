import type { IncomingMessage, ServerResponse } from 'http';
type HttpRequest = IncomingMessage;
type HttpResponse = ServerResponse;
type RouteHandler = (req: HttpRequest, res: HttpResponse, pathname: string, url: URL) => unknown;
type RegexRouteHandler = (req: HttpRequest, res: HttpResponse, match: RegExpMatchArray, pathname: string, url: URL) => unknown;
interface PrefixRoute {
    prefix: string;
    method?: string;
    handler: RouteHandler;
}
interface RegexRouteObject {
    pattern?: RegExp;
    method?: string;
    handler?: RegexRouteHandler;
    0?: RegExp;
    1?: string;
    2?: RegexRouteHandler;
}
declare function dispatch(req: HttpRequest, res: HttpResponse, pathname: string, url: URL): boolean;
declare const _default: {
    dispatch: typeof dispatch;
    exactRoutes: Map<string, RouteHandler>;
    prefixRoutes: PrefixRoute[];
    regexRoutes: RegexRouteObject[];
};
export = _default;
