"use strict";
const { JAILBREAK_INPUT_PATTERN_GROUPS, JAILBREAK_INPUT_PATTERNS, JAILBREAK_INPUT_RE, } = require('../core/constants');
function combinePatterns(patterns) {
    return new RegExp(patterns.map(pattern => pattern.source).join('|'), 'i');
}
module.exports = {
    combinePatterns,
    JAILBREAK_INPUT_PATTERN_GROUPS,
    JAILBREAK_INPUT_PATTERNS,
    JAILBREAK_INPUT_RE,
};
