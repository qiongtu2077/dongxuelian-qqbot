"use strict";
/**
 * MODULE: Markdown frontmatter parsing.
 * 职责: 解析文件开头连续的 frontmatter block，兼容 LF/CRLF 与中段 BOM。
 * 边界: 不读写文件，不校验 schema。
 */
function normalizeFrontmatterSource(content = '') {
    return String(content || '').replace(/\uFEFF/g, '');
}
function parseFrontmatterLines(frontmatterText = '', options = {}) {
    const meta = {};
    const rawMeta = {};
    const normalizeValue = typeof options.normalizeValue === 'function'
        ? options.normalizeValue
        : (value) => String(value ?? '').trim();
    const firstWins = options.firstWins !== false;
    for (const line of String(frontmatterText || '').split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line))
            continue;
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!kv)
            continue;
        if (firstWins && Object.prototype.hasOwnProperty.call(meta, kv[1]))
            continue;
        rawMeta[kv[1]] = String(kv[2] || '').trim();
        meta[kv[1]] = normalizeValue(kv[2]);
    }
    return { meta, rawMeta };
}
function parseFrontmatterDocument(content = '', options = {}) {
    const source = normalizeFrontmatterSource(content);
    if (!/^---\r?\n/.test(source)) {
        return { meta: {}, rawMeta: {}, body: source, hasFrontmatter: false, frontmatterText: '', blocks: [] };
    }
    const blocks = [];
    let cursor = 0;
    while (cursor < source.length) {
        if (blocks.length > 0) {
            const whitespace = (/^[ \t\r\n]*/.exec(source.slice(cursor)) || [''])[0];
            const candidate = cursor + whitespace.length;
            if (!/^---\r?\n/.test(source.slice(candidate)))
                break;
            cursor = candidate;
        }
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source.slice(cursor));
        if (!match)
            break;
        blocks.push(match[1] || '');
        cursor += match[0].length;
    }
    if (!blocks.length) {
        return { meta: {}, rawMeta: {}, body: source, hasFrontmatter: false, frontmatterText: '', blocks: [] };
    }
    const frontmatterText = blocks.join('\n---\n');
    const parsed = parseFrontmatterLines(frontmatterText, options);
    return {
        meta: parsed.meta,
        rawMeta: parsed.rawMeta,
        body: source.slice(cursor),
        hasFrontmatter: true,
        frontmatterText,
        blocks,
    };
}
module.exports = {
    normalizeFrontmatterSource,
    parseFrontmatterLines,
    parseFrontmatterDocument,
};
