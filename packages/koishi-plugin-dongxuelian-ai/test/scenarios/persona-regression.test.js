const fs = require('fs')
const path = require('path')
const {
  compilePersonaRuntimePlan,
  getPersonaRuntimePlanLegacySnapshot,
} = require('../../lib/persona/persona-runtime-plan')

const AI_ROOT = path.resolve(__dirname, '..', '..')
const FIXTURE_FILE = path.join(__dirname, '..', 'fixtures', 'persona-regression.json')

function loadRegressionSuite() {
  return JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'))
}

function resolveCaseSourceFile(item) {
  const rel = item?.source?.file || ''
  const file = path.resolve(AI_ROOT, rel)
  const relative = path.relative(AI_ROOT, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`unsafe persona regression source path: ${rel}`)
  }
  return file
}

function includesAll(text, values) {
  const source = String(text || '')
  return (values || []).every(value => source.includes(String(value)))
}

function collectRiskTags(suite) {
  const tags = new Set()
  for (const item of suite.cases || []) {
    for (const story of item.stories || []) {
      for (const tag of story.riskTags || []) tags.add(tag)
    }
  }
  return tags
}

async function run(t) {
  t.section('scenario: persona regression assets')

  const suite = loadRegressionSuite()
  const cases = Array.isArray(suite.cases) ? suite.cases : []
  t.check('persona regression suite has schema', suite.schema === 'persona.regression.v1')
  t.check('persona regression suite covers five personas', cases.length >= 5, JSON.stringify(cases.map(item => item.id)))

  const expectedNames = new Set(['persona-friendly', '爱弥斯', '椿', '长离', '特蕾西娅'])
  const actualNames = new Set()

  for (const item of cases) {
    const file = resolveCaseSourceFile(item)
    const exists = fs.existsSync(file)
    t.check(`persona regression source exists: ${item.id}`, exists, item.source && item.source.file)
    if (!exists) continue

    const content = fs.readFileSync(file, 'utf8')
    const plan = compilePersonaRuntimePlan({
      personaName: item.expected?.name || item.persona,
      personaContent: content,
      type: item.source?.type || 'persona',
      source: 'regression',
      file: path.basename(file),
    })
    const snapshot = getPersonaRuntimePlanLegacySnapshot(plan)
    actualNames.add(snapshot.personaName)

    t.check(`persona regression plan name matches: ${item.id}`, snapshot.personaName === item.expected?.name, JSON.stringify(snapshot))
    if (Object.prototype.hasOwnProperty.call(item.expected || {}, 'lore')) {
      t.check(`persona regression lore matches: ${item.id}`, snapshot.lore === item.expected.lore, JSON.stringify(snapshot))
    }
    if (Object.prototype.hasOwnProperty.call(item.expected || {}, 'will')) {
      t.check(`persona regression will matches: ${item.id}`, Number(snapshot.will) === Number(item.expected.will), JSON.stringify(snapshot))
    }
    t.check(`persona regression voice style anchors match: ${item.id}`, includesAll(snapshot.voiceStyle, item.expected?.voiceStyleIncludes), snapshot.voiceStyle)
    t.check(`persona regression body anchors match: ${item.id}`, includesAll(snapshot.promptBody, item.expected?.bodyIncludes), snapshot.promptBody.slice(0, 800))
    t.check(`persona regression has good and bad coverage: ${item.id}`, (item.stories || []).some(story => story.kind === 'good') && (item.stories || []).some(story => story.kind === 'bad' || story.kind === 'multiturn'), JSON.stringify(item.stories || []))

    for (const story of item.stories || []) {
      const hasAssertions = Array.isArray(story.must) && story.must.length > 0 && Array.isArray(story.mustNot) && story.mustNot.length > 0
      t.check(`persona regression story has assertions: ${item.id}/${story.name}`, hasAssertions, JSON.stringify(story))
      if (story.kind === 'multiturn') {
        t.check(`persona regression multiturn has steps: ${item.id}/${story.name}`, Array.isArray(story.messages) && story.messages.length >= 2, JSON.stringify(story.messages || []))
      }
      t.check(`persona regression story has risk tags: ${item.id}/${story.name}`, Array.isArray(story.riskTags) && story.riskTags.length > 0, JSON.stringify(story))
    }
  }

  t.check('persona regression covers required personas', [...expectedNames].every(name => actualNames.has(name)), JSON.stringify([...actualNames]))
  const riskTags = collectRiskTags(suite)
  t.check('persona regression covers required risk tags', (suite.requiredRiskTags || []).every(tag => riskTags.has(tag)), JSON.stringify([...riskTags]))
}

module.exports = { run }
