"use strict";
/**
 * MODULE: 语音识别（ASR）。
 * 职责: 提取语音 payload → 下载 → 转码 WAV → 调 MiMo 多模态模型转写 → 返回文字。
 * 边界: 不发送消息、不写对话历史、不改 conversation。
 * 状态: 无持久状态。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { requestChatCompletions } = require('../../core/api');
const { extractVoiceUrls, validatePublicHttpUrl, resolveAndValidateHostname } = require('../../core/utils');
const { DATA_DIR } = require('../../core/constants');
const ASR_TIMEOUT_MS = 10000;
const MAX_VOICE_BYTES = 2 * 1024 * 1024;
const VOICE_TEMP_DIR = path.join(DATA_DIR, 'voice-temp');
function getVoiceErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function extractVoicePayload(session) {
    const segments = Array.isArray(session?.event?.message) ? session.event.message : [];
    for (const seg of segments) {
        if (seg.type === 'record' && seg.data) {
            return { url: String(seg.data.url || ''), file: seg.data.file ? String(seg.data.file) : null };
        }
    }
    const content = String(session?.content || '');
    const urls = extractVoiceUrls(content);
    if (urls.length)
        return { url: urls[0], file: null };
    const cqFile = content.match(/\[CQ:record[^\]]*?file=([^,\]\s]+)/i);
    if (cqFile)
        return { url: '', file: cqFile[1] };
    return null;
}
async function downloadVoiceFile(url, destPath) {
    return new Promise((resolve) => {
        let req = null;
        let timer = null;
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            try {
                if (req)
                    req.destroy();
            }
            catch { /* non-critical: request may already be closed */
            }
            resolve(value || null);
        };
        (async () => {
            let parsed;
            try {
                parsed = validatePublicHttpUrl(url);
                await resolveAndValidateHostname(parsed);
            }
            catch { /* non-critical: invalid or private voice URL is treated as unreadable */
                return finish(null);
            }
            try {
                const mod = parsed.protocol === 'https:' ? require('https') : require('http');
                timer = setTimeout(() => finish(null), 15000);
                req = mod.get(parsed, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                    if (res.statusCode !== 200) {
                        res.resume();
                        return finish(null);
                    }
                    const declared = parseInt(String(res.headers['content-length'] || ''), 10);
                    if (Number.isFinite(declared) && declared > MAX_VOICE_BYTES) {
                        res.resume();
                        return finish(null);
                    }
                    const chunks = [];
                    let received = 0;
                    res.on('data', (c) => {
                        if (settled)
                            return;
                        received += c.length;
                        if (received > MAX_VOICE_BYTES) {
                            res.resume();
                            return finish(null);
                        }
                        chunks.push(c);
                    });
                    res.on('end', () => {
                        const buf = Buffer.concat(chunks);
                        if (!buf.length || buf.length > MAX_VOICE_BYTES)
                            return finish(null);
                        try {
                            fs.mkdirSync(path.dirname(destPath), { recursive: true });
                            fs.writeFileSync(destPath, buf);
                            finish(destPath);
                        }
                        catch { /* non-critical: temp voice write failure makes ASR unavailable */
                            finish(null);
                        }
                    });
                    res.on('error', () => finish(null));
                });
                req.on('error', () => finish(null));
            }
            catch { /* non-critical: network setup failure makes this voice unreadable */
                finish(null);
            }
        })();
    });
}
function convertToWav(srcPath) {
    return new Promise((resolve) => {
        const outPath = srcPath + '.wav';
        execFile('ffmpeg', ['-y', '-i', srcPath, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', outPath], { timeout: 10000 }, (err) => {
            if (!err && fs.existsSync(outPath))
                return resolve(outPath);
            try {
                const silk = require('silk-wasm');
                const input = fs.readFileSync(srcPath);
                if (silk.isSilk(input)) {
                    const { data } = silk.decode(input, 16000);
                    const wavBuf = pcmToWav(data, 16000, 1, 16);
                    fs.writeFileSync(outPath, wavBuf);
                    return resolve(outPath);
                }
            }
            catch { /* non-critical: silk fallback is optional after ffmpeg conversion failure */
            }
            resolve(null);
        });
    });
}
function pcmToWav(pcmData, sampleRate, channels, bitsPerSample) {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcmData.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, Buffer.from(pcmData)]);
}
async function callModelAsr(wavPath, config) {
    const buf = fs.readFileSync(wavPath);
    const base64 = `data:audio/wav;base64,${buf.toString('base64')}`;
    const messages = [{
            role: 'user',
            content: [
                { type: 'text', text: '请将这段语音转写成文字，只返回转写的文字本身，不要添加任何其他内容。' },
                { type: 'input_audio', input_audio: { data: base64 } },
            ],
        }];
    const { MIMORIUM_KEY_FILE } = require('../../core/constants');
    let mimoriumKey = '';
    try {
        mimoriumKey = fs.readFileSync(MIMORIUM_KEY_FILE, 'utf8').trim();
    }
    catch { /* non-critical: ASR falls back to current config apiKey */
    }
    const asrConfig = {
        ...config,
        provider: 'mimorium',
        model: 'mimo-v2.5',
        baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
        apiKey: mimoriumKey || config.apiKey,
    };
    const result = await requestChatCompletions(messages, asrConfig, { max_tokens: 500, _timeoutMs: ASR_TIMEOUT_MS });
    const resultRecord = result && typeof result === 'object' ? result : null;
    const text = typeof result === 'string' ? result : (resultRecord && resultRecord.content || '');
    return String(text || '').trim();
}
async function transcribeVoice(session, config) {
    const payload = extractVoicePayload(session);
    if (!payload)
        return null;
    const id = String(session?.messageId || Date.now());
    fs.mkdirSync(VOICE_TEMP_DIR, { recursive: true });
    const tempFile = path.join(VOICE_TEMP_DIR, `asr-${id.replace(/[^a-zA-Z0-9]/g, '_')}`);
    let downloaded = null;
    if (payload.url && payload.url.startsWith('http')) {
        downloaded = await downloadVoiceFile(payload.url, tempFile);
    }
    if (!downloaded && payload.file) {
        try {
            const { callGetRecord } = require('../../core/api');
            const recordInfo = await callGetRecord(payload.file);
            if (recordInfo && recordInfo.file && fs.existsSync(recordInfo.file))
                downloaded = String(recordInfo.file);
        }
        catch { /* non-critical: OneBot get_record failure makes ASR unavailable */
        }
    }
    if (!downloaded)
        return null;
    const wavPath = await convertToWav(downloaded);
    if (downloaded === tempFile) {
        try {
            fs.unlinkSync(downloaded);
        }
        catch { /* non-critical: best-effort ASR temp input cleanup */
        }
    }
    if (!wavPath)
        return null;
    try {
        const text = await callModelAsr(wavPath, config);
        return text || null;
    }
    finally {
        try {
            fs.unlinkSync(wavPath);
        }
        catch { /* non-critical: best-effort ASR wav cleanup */
        }
    }
}
module.exports = {
    extractVoicePayload,
    downloadVoiceFile,
    convertToWav,
    callModelAsr,
    transcribeVoice,
};
