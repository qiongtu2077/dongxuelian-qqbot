"use strict";
/**
 * MODULE: 日报明确对象交换的共用合法性检查。
 * 职责: 拒绝不确定字段及JSON重复键。
 * 边界: 不请求模型、不处理覆盖或修改原话；重复键检查只接已经成功解析的JSON。
 * 状态: 无全局状态。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertReportFields = assertReportFields;
exports.assertReportDisplayText = assertReportDisplayText;
exports.assertReportObjectKeys = assertReportObjectKeys;
// 精确字段集合拒绝未知形状，不能把额外输出当作已验证材料。
function assertReportFields(value, names, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== names.length || names.some(name => !Object.prototype.hasOwnProperty.call(value, name))) {
        throw new Error('[FIELD_TYPE] ' + label + '必须使用完整明确字段');
    }
}
// 生成展示文字不能携带当前引用表的裸标识；不改原话，也不猜人名替换。
function assertReportDisplayText(text, references, label) {
    const known = new Set(references);
    // 只反馈当前引用表中实际出现的编号，不把原句或未知词元送入恢复提示。
    const leaked = [...new Set((text.match(/[A-Za-z][A-Za-z0-9_]*/g) || []).filter(token => known.has(token)))];
    if (leaked.length) {
        throw new Error('[LOCAL_REF_IN_TEXT] ' + label + '不能包含请求内人物或来源编号；检测到：'
            + leaked.slice(0, 8).join(',') + (leaked.length > 8 ? '（仅列前八项）' : '')
            + '。编号仅可用于结构化引用字段；展示文字请按原文描述讨论对象，或使用“有人／该成员”等称呼，不猜测姓名。');
    }
}
// 已解析JSON逐对象检查重复键，拒绝最后值覆盖来源；转义后的键按真实名称比较。
function assertReportObjectKeys(text) {
    const source = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g, stack = [];
    let previous = '', match;
    while ((match = tokens.exec(source))) {
        const token = match[0];
        if (token === '{')
            stack.push(new Set());
        else if (token === '[')
            stack.push(null);
        else if (token === '}' || token === ']')
            stack.pop();
        else if (token === ':') {
            const names = stack[stack.length - 1], name = JSON.parse(previous);
            if (names.has(name))
                throw new Error('[FIELD_DUPLICATE] JSON对象含重复属性');
            names.add(name);
        }
        previous = token;
    }
}
