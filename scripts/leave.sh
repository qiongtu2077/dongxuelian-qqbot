mkdir -p /root/koishi-app/node_modules/koishi-plugin-group-leave-notice/lib
cat > /root/koishi-app/node_modules/koishi-plugin-group-leave-notice/package.json <<'ENDOFKOISHICODE'
{
  "name": "koishi-plugin-group-leave-notice",
  "version": "0.1.0",
  "main": "lib/index.js"
}
ENDOFKOISHICODE
cat > /root/koishi-app/node_modules/koishi-plugin-group-leave-notice/lib/index.js <<'ENDOFKOISHICODE'
exports.name = 'group-leave-notice'

const PLUGIN_VERSION = '0.1.0'

function getGuildId(session) {
  return session.guildId || session.event?.guild?.id || session.event?.channel?.id
}

function getUserId(session) {
  return session.userId || session.event?.user?.id || session.event?.member?.user?.id
}

async function sendLeaveNotice(session) {
  const guildId = getGuildId(session)
  const userId = getUserId(session)
  if (!guildId || !userId) return

  await session.bot.sendMessage(guildId, userId + ' 退群了')
}

exports.apply = (ctx) => {
  ctx.on('ready', () => {
    ctx.logger('group-leave-notice').info('group-leave-notice ' + PLUGIN_VERSION + ' loaded')
  })

  ctx.on('guild-member-removed', async (session) => {
    try {
      await sendLeaveNotice(session)
    } catch (error) {
      ctx.logger('group-leave-notice').warn(error.message)
    }
  })
}

ENDOFKOISHICODE
node <<'SCRIPT'
const fs=require("fs");const c="/root/koishi-app/koishi.yml";let t=fs.readFileSync(c,"utf8");let ec=0;for(const x of t.split(/\r?\n/))if(/^\s*koishi-plugin-group-leave-notice(?::[a-z0-9]+)?\s*:/.test(x))ec++;if(ec===1){console.log("already enabled");process.exit(0)}if(ec>1){const f=[];let k=false;for(const x of t.split(/\r?\n/)){if(/^\s*koishi-plugin-group-leave-notice(?::[a-z0-9]+)?\s*:/.test(x)){if(!k){f.push(x);k=true}}else f.push(x)}fs.writeFileSync(c,f.join("\n"),"utf8");console.log("cleaned duplicates");process.exit(0)}fs.copyFileSync(c,c+".bak-koishi-plugin-group-leave-notice");const l=t.split(/\r?\n/);let ins=false;for(let i=0;i<l.length;i++){const m=l[i].match(/^(\s*)group:basic:\s*$/);if(m){l.splice(i+1,0,m[1]+"  koishi-plugin-group-leave-notice: {}");ins=true;break}}if(!ins)for(let i=0;i<l.length;i++){const m=l[i].match(/^(\s*)plugins:\s*$/);if(m){l.splice(i+1,0,m[1]+"  koishi-plugin-group-leave-notice: {}");ins=true;break}}if(!ins){l.push("");l.push("plugins:");l.push("  koishi-plugin-group-leave-notice: {}")}fs.writeFileSync(c,l.join("\n"),"utf8");console.log("enabled")
SCRIPT
printf "\nInstalled koishi-plugin-group-leave-notice 0.1.0\n"
