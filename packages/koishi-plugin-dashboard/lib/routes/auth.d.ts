declare function handleLogin(req: any, res: any): any;
declare function handleAdminVerify(req: any, res: any): any;
declare function handleChangePassword(req: any, res: any): any;
declare function handleResetPassword(req: any, res: any): any;
declare function authMiddleware(req: any, res: any, pathname: any): boolean;
declare const _default: {
    routes: {
        'POST /dashboard/api/login': typeof handleLogin;
        'POST /dashboard/api/admin/verify': typeof handleAdminVerify;
        'PUT /dashboard/api/auth/password': typeof handleChangePassword;
        'POST /dashboard/api/auth/reset-password': typeof handleResetPassword;
    };
    authMiddleware: typeof authMiddleware;
};
export = _default;
