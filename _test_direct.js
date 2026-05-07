const { execSync } = require('child_process')
const result = execSync('node -e "process.env.DONGXUELIAN_AI_DATA_DIR=\'/root/koishi-app/data\';const p=require(\'path\');const f=p.join(process.env.DONGXUELIAN_AI_DATA_DIR,\'dashboard-pwd.txt\');const fs=require(\'fs\');function rfs(pp){try{if(fs.statSync(pp).isFile())return fs.readFileSync(pp,\'utf8\').trim()}catch{}}const pw=rfs(f)||\'123456\';console.log(JSON.stringify(pw))"', { encoding: 'utf8' })
console.log('Password from same logic:', result.trim())
