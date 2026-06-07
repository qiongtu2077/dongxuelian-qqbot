"use strict";
const { readResourceSnapshot } = require('../resource-scheduler/resource-snapshot');
// 读取当前 Bot 模式，供入口快速判断。
function readBotModeState() {
    return readResourceSnapshot();
}
module.exports = {
    readBotModeState,
};
