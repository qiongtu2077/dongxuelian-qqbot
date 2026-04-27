const fs = require('fs');
const path = require('path');

const BASE = '/root/koishi-app';

// Read and fix help file
const helpPath = path.join(BASE, 'node_modules/koishi-plugin-dongxuelian-help/lib/index.js');
let help = fs.readFileSync(helpPath, 'utf8');
if (help.charCodeAt(0) === 0xFEFF) help = help.slice(1);
help = help.replace(/^\?+/g, ''); // remove corrupted BOM chars
fs.writeFileSync(helpPath, help, 'utf8');
console.log('help fixed, first char:', help.charCodeAt(0).toString(16));

// Read and fix ai file
const aiPath = path.join(BASE, 'node_modules/koishi-plugin-dongxuelian-ai/lib/index.js');
let ai = fs.readFileSync(aiPath, 'utf8');
if (ai.charCodeAt(0) === 0xFEFF) ai = ai.slice(1);
ai = ai.replace(/^\?+/g, '');
fs.writeFileSync(aiPath, ai, 'utf8');
console.log('ai fixed, first char:', ai.charCodeAt(0).toString(16));
