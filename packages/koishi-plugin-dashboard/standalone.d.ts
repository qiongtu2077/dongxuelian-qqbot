#!/usr/bin/env node
/**
 * Standalone Dashboard server.
 * Runs independently from the Koishi lifecycle on DASHBOARD_PORT.
 */
import type { IncomingMessage } from 'http';
declare const _default: {
    isLoopbackAddress: (address: unknown) => boolean;
    isLocalAuthBypass: (req: IncomingMessage) => boolean;
    getRemoteAddress: (req: IncomingMessage | null | undefined) => string;
    KOISHI_PID_FILE: string;
    CONTENT_SECURITY_POLICY: string;
};
export = _default;
