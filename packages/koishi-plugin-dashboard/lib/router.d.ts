declare function dispatch(req: any, res: any, pathname: any, url: any): boolean;
declare const _default: {
    dispatch: typeof dispatch;
    exactRoutes: Map<any, any>;
    prefixRoutes: any[];
    regexRoutes: any[];
};
export = _default;
