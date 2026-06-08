'use strict';
const fs = require('fs');
const { json, log, collectBody, getRemoteAddress, writeFileSyncSafe, } = require('../utils');
const { isLocalAuthBypass, isLoginRateLimited, recordLoginFailure, clearLoginFails, getAccessPasswordRecord, getAdminPassword, createToken, createAdminToken, validateToken, requireAdmin, getResetToken, generateResetToken, resetDashboardCredentials, rotateSessionSecret, safeCompare, verifyPassword, hashPassword, removeLegacyAccessPasswordAfterUpgrade, } = require('../auth');
const { ADMIN_PWD_FILE, ACCESS_PWD_FILE, LEGACY_ACCESS_PWD_FILE } = require('../paths');
function parseBody(body) {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : {};
}
// Handles access-password login and returns a normal dashboard token.
function handleLogin(req, res) {
    const loginIp = getRemoteAddress(req);
    if (!isLocalAuthBypass(req) && isLoginRateLimited(loginIp)) {
        return json(res, { ok: false, message: 'too many login attempts; please try again later' }, 429);
    }
    collectBody(req, res, (body) => {
        try {
            const { password: rawPassword } = parseBody(body);
            const password = String(rawPassword || '');
            const accessRecord = getAccessPasswordRecord();
            const stored = accessRecord.value;
            if (!stored && !isLocalAuthBypass(req)) {
                log('login rejected: access password is not configured');
                return json(res, { ok: false, message: 'access password is not configured' }, 503);
            }
            if (isLocalAuthBypass(req)) {
                clearLoginFails(loginIp);
                return json(res, { ok: true, token: createToken() });
            }
            verifyPassword(password, stored, ACCESS_PWD_FILE).then((match) => {
                if (match) {
                    return removeLegacyAccessPasswordAfterUpgrade(accessRecord, password).then(() => {
                        clearLoginFails(loginIp);
                        return json(res, { ok: true, token: createToken() });
                    });
                }
                recordLoginFailure(loginIp);
                log('login failed');
                return json(res, { ok: false, message: 'password is incorrect' }, 401);
            }).catch(() => {
                return json(res, { ok: false, message: 'internal authentication error' }, 500);
            });
        }
        catch {
            return json(res, { ok: false, message: 'invalid request' }, 400);
        }
    });
}
// Verifies the admin password after normal access-token authentication.
function handleAdminVerify(req, res) {
    const loginIp = getRemoteAddress(req);
    if (isLocalAuthBypass(req))
        return json(res, { ok: true, token: createAdminToken() });
    if (isLoginRateLimited(loginIp)) {
        return json(res, { ok: false, message: 'too many authentication attempts; please try again later' }, 429);
    }
    collectBody(req, res, (body) => {
        try {
            const { password: rawPassword } = parseBody(body);
            const password = String(rawPassword || '');
            const stored = getAdminPassword();
            verifyPassword(password, stored, ADMIN_PWD_FILE).then((match) => {
                if (match) {
                    clearLoginFails(loginIp);
                    return json(res, { ok: true, token: createAdminToken() });
                }
                recordLoginFailure(loginIp);
                return json(res, { ok: false, message: 'admin password is incorrect' }, 401);
            }).catch(() => {
                return json(res, { ok: false, message: 'internal authentication error' }, 500);
            });
        }
        catch {
            return json(res, { ok: false, message: 'invalid request' }, 400);
        }
    });
}
// Changes access/admin passwords and rotates token signing secrets.
function handleChangePassword(req, res) {
    if (isLocalAuthBypass(req)) {
        return json(res, { ok: false, message: 'password login is disabled in local deployer mode', code: 'AUTH_DISABLED_LOCAL' }, 400);
    }
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, (body) => {
        try {
            const { type, oldPassword, newPassword } = parseBody(body);
            if (!newPassword || newPassword.length < 3) {
                return json(res, { ok: false, message: 'new password must be at least 3 characters' }, 400);
            }
            if (!/^[A-Za-z0-9_~!@#$%^&*()\-+=\[\]{}<>,.?/|\\:;"'`]+$/.test(newPassword)) {
                return json(res, { ok: false, message: 'password contains unsupported characters' }, 400);
            }
            if (type === 'admin') {
                const stored = getAdminPassword();
                verifyPassword(String(oldPassword || ''), stored, ADMIN_PWD_FILE).then(async (match) => {
                    if (!match) {
                        return json(res, { ok: false, message: 'current admin password is incorrect' }, 401);
                    }
                    const hash = await hashPassword(newPassword);
                    writeFileSyncSafe(ADMIN_PWD_FILE, hash);
                    rotateSessionSecret();
                    return json(res, { ok: true, message: 'admin password updated' });
                }).catch(() => {
                    return json(res, { ok: false, message: 'internal authentication error' }, 500);
                });
            }
            else if (type === 'access') {
                hashPassword(newPassword).then((hash) => {
                    writeFileSyncSafe(ACCESS_PWD_FILE, hash);
                    rotateSessionSecret();
                    return json(res, { ok: true, message: 'access password updated; please log in again' });
                }).catch(() => {
                    return json(res, { ok: false, message: 'internal authentication error' }, 500);
                });
            }
            else {
                return json(res, { ok: false, message: 'invalid password type' }, 400);
            }
        }
        catch {
            return json(res, { ok: false, message: 'invalid request' }, 400);
        }
    });
}
// Resets password files using the filesystem reset token.
function handleResetPassword(req, res) {
    if (isLocalAuthBypass(req)) {
        return json(res, { ok: false, message: 'password login is disabled in local deployer mode', code: 'AUTH_DISABLED_LOCAL' }, 400);
    }
    collectBody(req, res, (body) => {
        try {
            const { resetToken } = parseBody(body);
            const stored = getResetToken();
            const inputToken = String(resetToken || '').trim();
            const storedToken = String(stored || '').trim();
            if (!storedToken || !inputToken || !safeCompare(inputToken, storedToken)) {
                return json(res, { ok: false, message: 'reset token is invalid' }, 403);
            }
            try {
                fs.unlinkSync(ACCESS_PWD_FILE);
            }
            catch { /* non-critical: reset cleanup best effort */ }
            try {
                fs.unlinkSync(ADMIN_PWD_FILE);
            }
            catch { /* non-critical: reset cleanup best effort */ }
            try {
                fs.unlinkSync(LEGACY_ACCESS_PWD_FILE);
            }
            catch { /* non-critical: reset cleanup best effort */ }
            resetDashboardCredentials();
            generateResetToken();
            return json(res, { ok: true, message: 'passwords were reset to new random values; read the dashboard password files on the server' });
        }
        catch {
            return json(res, { ok: false, message: 'invalid request' }, 400);
        }
    });
}
// Enforces normal access-token authentication for dashboard API routes.
function authMiddleware(req, res, pathname) {
    const isPublicGalleryImage = pathname.startsWith('/dashboard/api/gallery/image/') && req.method === 'GET';
    if (pathname.startsWith('/dashboard/api/') && !isPublicGalleryImage && !isLocalAuthBypass(req)) {
        const authHeader = String(req.headers['authorization'] || '');
        const token = authHeader.replace(/^Bearer\s+/i, '');
        if (!validateToken(token)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, message: 'login required', code: 'AUTH_REQUIRED' }));
            return false;
        }
    }
    return true;
}
const routes = {
    'POST /dashboard/api/login': handleLogin,
    'POST /dashboard/api/admin/verify': handleAdminVerify,
    'PUT /dashboard/api/auth/password': handleChangePassword,
    'POST /dashboard/api/auth/reset-password': handleResetPassword,
};
module.exports = { routes, authMiddleware: authMiddleware };
