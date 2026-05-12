exports.name = 'group-leave-notice'

const PLUGIN_VERSION = '0.1.0'

function getGuildId(session) {
  return session.channelId || session.guildId || session.event?.guild?.id || session.event?.channel?.id
}

function getUserId(session) {
  return session.userId || session.event?.user?.id || session.event?.member?.user?.id
}

async function sendLeaveNotice(session) {
  const guildId = getGuildId(session)
  const userId = getUserId(session)
  if (!guildId || !userId || typeof session.bot?.sendMessage !== 'function') return

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
