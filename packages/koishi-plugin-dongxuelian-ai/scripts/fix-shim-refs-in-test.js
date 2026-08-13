const fs = require('fs')
const path = require('path')

const LIB = path.join(__dirname, '..', 'lib')
const testFile = path.join(__dirname, '..', 'test', 'cascade-test.js')
let src = fs.readFileSync(testFile, 'utf8')

// Find all path.join(LIB, 'xxx') references where xxx is a deleted shim
// Pattern: path.join(LIB, 'name') where name doesn't contain '/'
const issues = []
const regex = /path\.join\(LIB,\s*'([^']+)'\)/g
let match
while ((match = regex.exec(src)) !== null) {
  const relPath = match[1]
  const fullPath = path.join(LIB, relPath + '.js')
  const fullPathNoExt = path.join(LIB, relPath)
  if (!fs.existsSync(fullPath) && !fs.existsSync(fullPathNoExt) && !fs.existsSync(fullPathNoExt + '/index.js')) {
    // Check if it's a directory
    if (!fs.existsSync(fullPathNoExt)) {
      issues.push({ index: match.index, path: relPath, full: match[0] })
    }
  }
}

console.log(`Found ${issues.length} references to non-existent paths:`)
const unique = [...new Set(issues.map(i => i.path))]
unique.forEach(p => console.log(`  ${p}`))

// Build replacement map for single-segment paths (shim names → real paths)
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

// Replace path.join(LIB, 'shimName') with path.join(LIB, 'real', 'path')
let replacements = 0
src = src.replace(/path\.join\(LIB,\s*'([^']+)'\)/g, (match, name) => {
  if (shimToReal[name]) {
    const parts = shimToReal[name].split('/')
    const newPath = `path.join(LIB, ${parts.map(p => `'${p}'`).join(', ')})`
    replacements++
    return newPath
  }
  return match
})

// Also handle require.cache clearing patterns like:
// for (const rel of ['constants', 'core/constants', ...])
//   delete require.cache[require.resolve(path.join(LIB, rel))]
// These have the shim name as a string in an array
// Pattern: 'shimName' inside arrays used for cache clearing
// We need to remove the shim entries from these arrays since the real path is already there

// Find arrays that contain both a shim name and its real path
const arrayPattern = /\[([^\]]*)\]/g
let arrayMatch
const newSrc = src.replace(/for\s*\(const\s+rel\s+of\s+\[([^\]]+)\]\)/g, (match, content) => {
  const entries = content.split(',').map(s => s.trim())
  const filtered = entries.filter(entry => {
    const name = entry.replace(/^'|'$/g, '')
    // Remove if it's a shim name (single segment, no slash) that maps to a real path
    if (shimToReal[name]) {
      replacements++
      return false
    }
    return true
  })
  return `for (const rel of [${filtered.join(', ')}])`
})

fs.writeFileSync(testFile, newSrc, 'utf8')
console.log(`\n${replacements} replacements made`)
console.log('Written successfully')
