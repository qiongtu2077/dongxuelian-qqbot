"use strict";
/**
 * MODULE: pet-bridge plugin entry.
 * 职责: Start WebSocket server on port 9600 for desktop pet to connect.
 *        Delegates message handling to ./protocol.js.
 * 边界: Does NOT modify Koishi middleware, core plugin state, or conversation data.
 *        Only manages WS server lifecycle.
 */
const { WebSocketServer } = require('ws');
const { handleMessage } = require('./protocol');
const name = 'pet-bridge';
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function apply(ctx, config) {
    const port = config?.port ?? 9600;
    const logger = ctx.logger('pet-bridge');
    ctx.on('ready', () => {
        const wss = new WebSocketServer({ port, host: '127.0.0.1' });
        let closed = false;
        logger.info('pet-bridge: WS server listening on 127.0.0.1:' + port);
        wss.on('error', (err) => {
            logger.warn(`WS server error: ${err.message}`);
        });
        wss.on('connection', (ws) => {
            ws.on('message', async (raw) => {
                let msgId = null;
                try {
                    const parsed = JSON.parse(raw.toString());
                    const msg = parsed && typeof parsed === 'object' ? parsed : {};
                    msgId = msg.id;
                    const response = await handleMessage(parsed);
                    if (ws.readyState === 1)
                        ws.send(JSON.stringify(response));
                }
                catch (err) {
                    const message = getErrorMessage(err);
                    logger.warn(`message error: ${message}`);
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({ type: 'response', id: msgId, success: false, payload: { error: message } }));
                    }
                }
            });
            ws.on('error', (err) => {
                logger.warn(`WS error: ${err.message}`);
            });
        });
        ctx.on('dispose', () => {
            if (closed)
                return;
            closed = true;
            wss.close((err) => {
                if (err)
                    logger.warn(`WS close error: ${err.message}`);
                else
                    logger.info('pet-bridge: server closed');
            });
        });
    });
}
module.exports = { name, apply };
