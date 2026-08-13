const fs = require('fs')
const path = require('path')

const testFile = path.join(__dirname, '..', 'test', 'cascade-test.js')
let src = fs.readFileSync(testFile, 'utf8')

// Map of old shim require paths to new real paths
const shimToReal = {
  'constants': 'core/constants',
  'utils': 'core/utils',
  'api': 'core/api',
  'frontmatter': 'core/frontmatter',
  'onebot-endpoint': 'core/onebot-endpoint',
  'redactor': 'core/redactor',
  'logging-config': 'core/logging-config',
  'runtime-config': 'core/runtime-config',
  'user-blacklist': 'core/user-blacklist',
  'runtime-settings': 'behavior/runtime-settings',
  'admin-commands': 'commands/admin-commands',
  'persona': 'persona/persona',
  'persona-schema': 'persona/persona-schema',
  'persona-diagnostics': 'persona/persona-diagnostics',
  'persona-runtime-plan': 'persona/persona-runtime-plan',
  'persona-profile': 'persona/persona-profile',
  'persona-lore-router': 'persona/persona-lore-router',
  'persona-fallback': 'persona/persona-fallback',
  'skills-loader': 'persona/skills/skills-loader',
  'skill-seeds': 'persona/skills/skill-seeds',
  'external-tool-policy': 'routing/external-tool-policy',
  'group-scene-index': 'routing/group-scene-index',
  'agent-auto-route-flow': 'routing/agent-auto-route-flow',
  'reminder-route': 'routing/reminder-route',
  'uploaded-file-action-route': 'routing/uploaded-file-action-route',
  'search-context': 'routing/search-context',
  'file-quick-read': 'routing/file-quick-read',
  'message-segment': 'message/message-segment',
  'message-reader': 'message/message-reader',
  'forward': 'message/forward',
  'incoming-message-flow': 'message/incoming-message-flow',
  'incoming-file': 'media/file/incoming-file',
  'file-safety': 'media/file/file-safety',
  'file-store': 'media/file/file-store',
  'file-analyzer': 'media/file/file-analyzer',
  'file-followup-guard': 'media/file/file-followup-guard',
  'image-store': 'media/image/image-store',
  'image-analyzer': 'media/image/image-analyzer',
  'image-analysis-sanitizer': 'media/image/image-analysis-sanitizer',
  'vision': 'media/image/vision',
  'voice': 'media/voice/voice',
  'voice-assets': 'media/voice/voice-assets',
  'tts': 'media/voice/tts',
  'chat-memory': 'chat/chat-memory',
  'chat-prompt-builder': 'chat/chat-prompt-builder',
  'chat-jailbreak-flow': 'chat/chat-jailbreak-flow',
  'chat-topic-switch': 'chat/chat-topic-switch',
  'chat-final-output-flow': 'chat/chat-final-output-flow',
  'chat-agent-retell-flow': 'chat/chat-agent-retell-flow',
  'chat-result-flow': 'chat/chat-result-flow',
  'chat-send-flow': 'chat/chat-send-flow',
  'chat-tool-flow': 'chat/chat-tool-flow',
  'chat-tools': 'chat/chat-tools',
  'agent-chat-bridge': 'chat/agent-chat-bridge',
  'agent-retell-guard': 'chat/agent-retell-guard',
  'affect-router': 'behavior/affect-router',
  'sticker-shadow': 'behavior/sticker-shadow',
  'emotion-renderer': 'behavior/emotion-renderer',
  'random-reply-mode': 'behavior/random-reply-mode',
  'random-persona-risk': 'behavior/random-persona-risk',
  'random-state': 'behavior/random-state',
  'random-voice-rate': 'behavior/random-voice-rate',
  'rare-voice': 'behavior/rare-voice',
  'repeat': 'behavior/repeat',
  'sensitive': 'behavior/sensitive',
  'retaliation': 'behavior/retaliation',
  'session-compat': 'lifecycle/session-compat',
  'bot-resolver': 'lifecycle/bot-resolver',
  'channel-task-queue': 'lifecycle/channel-task-queue',
  'event-dump': 'lifecycle/event-dump',
  'startup-schedulers': 'lifecycle/startup-schedulers',
  'plugin-lifecycle': 'lifecycle/plugin-lifecycle',
  'reply': 'reply/reply',
  'reply-timing': 'reply/reply-timing',
  'reply-guard': 'reply/reply-guard',
  'safe-send': 'reply/safe-send',
  'send-guard': 'reply/send-guard',
  'diagnostics': 'diagnostics/diagnostics',
  'shared-record-text': 'diagnostics/shared-record-text',
  'health-check': 'diagnostics/health-check',
}

// Replace require('./shimName') string literals inside assertions
// These appear as: "require('./skills-loader')" inside .includes() checks
let count = 0
for (const [shimName, realPath] of Object.entries(shimToReal)) {
  const oldStr = `require('./${shimName}')`
  const newStr = `require('./${realPath}')`
  if (src.includes(oldStr)) {
    const occurrences = src.split(oldStr).length - 1
    src = src.split(oldStr).join(newStr)
    count += occurrences
    console.log(`  ${oldStr} → ${newStr} (${occurrences}x)`)
  }

  // Also handle require('../shimName') patterns (from subdirectory modules)
  const oldStr2 = `require('../${shimName}')`
  const newStr2 = `require('../${realPath}')`
  if (src.includes(oldStr2)) {
    const occurrences = src.split(oldStr2).length - 1
    src = src.split(oldStr2).join(newStr2)
    count += occurrences
    console.log(`  ${oldStr2} → ${newStr2} (${occurrences}x)`)
  }
}

console.log(`\nTotal: ${count} string replacements`)
fs.writeFileSync(testFile, src, 'utf8')
console.log('Written successfully')
