'use strict';
const { authMiddleware } = require('./routes/auth');
const galleryRoutes = require('./routes/gallery');
const authRoutes = require('./routes/auth');
const configRoutes = require('./routes/config');
const agentRoutes = require('./routes/agent');
const settingsRoutes = require('./routes/settings');
const botRoutes = require('./routes/bot');
const deployRoutes = require('./routes/deploy');
const exactRoutes = new Map();
const prefixRoutes = [];
const regexRoutes = [];
for (const mod of [galleryRoutes, authRoutes, configRoutes, agentRoutes, settingsRoutes, botRoutes, deployRoutes]) {
    if (mod.routes)
        for (const [key, handler] of Object.entries(mod.routes))
            exactRoutes.set(key, handler);
    if (mod.prefixRoutes) {
        if (Array.isArray(mod.prefixRoutes)) {
            for (const item of mod.prefixRoutes)
                prefixRoutes.push(item);
        }
        else {
            for (const [prefix, handler] of Object.entries(mod.prefixRoutes))
                prefixRoutes.push({ prefix, method: prefix.split(' ')[0], handler });
        }
    }
    if (mod.regexRoutes)
        for (const item of mod.regexRoutes)
            regexRoutes.push(item);
}
const preAuthKeys = new Set([
    'POST /dashboard/api/login',
    'POST /dashboard/api/auth/reset-password',
]);
// Dispatches an HTTP request to exact, prefix, or regex route handlers.
function dispatch(req, res, pathname, url) {
    const method = req.method;
    const key = method + ' ' + pathname;
    if (preAuthKeys.has(key)) {
        const handler = exactRoutes.get(key);
        if (handler) {
            handler(req, res, pathname, url);
            return true;
        }
    }
    if (!authMiddleware(req, res, pathname))
        return true;
    const handler = exactRoutes.get(key);
    if (handler) {
        handler(req, res, pathname, url);
        return true;
    }
    for (const pfx of prefixRoutes) {
        if (pfx.method && pfx.method !== method)
            continue;
        if (pathname.startsWith(pfx.prefix)) {
            pfx.handler(req, res, pathname, url);
            return true;
        }
    }
    for (const route of regexRoutes) {
        const pattern = route.pattern || route[0];
        const routeMethod = route.method || route[1];
        const rxHandler = route.handler || route[2];
        if (!pattern || !rxHandler || method !== routeMethod)
            continue;
        const match = pathname.match(pattern);
        if (match) {
            rxHandler(req, res, match, pathname, url);
            return true;
        }
    }
    return false;
}
module.exports = { dispatch, exactRoutes, prefixRoutes, regexRoutes };
