const command = require('./command.test')
const chat = require('./chat.test')
const repeat = require('./repeat.test')
const sticker = require('./sticker.test')
const sensitive = require('./sensitive.test')
const fallback = require('./fallback.test')
const forward = require('./forward.test')
const vision = require('./vision.test')
const random = require('./random.test')
const persistence = require('./persistence.test')
const concurrency = require('./concurrency.test')
const setup = require('./setup.test')
const personaPrompt = require('./persona-prompt.test')
const sendGuard = require('./send-guard.test')

const SCENARIOS = [
  command,
  chat,
  repeat,
  sticker,
  sensitive,
  fallback,
  forward,
  vision,
  random,
  persistence,
  concurrency,
  setup,
  personaPrompt,
  sendGuard,
]

async function runScenarioTests(t) {
  for (const scenario of SCENARIOS) {
    await scenario.run(t)
  }
}

module.exports = { runScenarioTests }
