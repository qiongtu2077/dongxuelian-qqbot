const fs = require('fs/promises')
const path = require('path')
const { createTestDataDir } = require('../fake/file')
const { writeJsonFile, readJsonFile } = require('../../lib/utils')

async function run(t) {
  t.section('scenario: persistence write stress')

  const data = createTestDataDir()
  try {
    const target = path.join(data.dataDir, 'stress', 'state.json')
    const payloads = Array.from({ length: 64 }, (_, index) => ({
      writer: index,
      label: `writer-${index}`,
      values: Array.from({ length: 32 }, (__, item) => `value-${index}-${item}`),
    }))

    await Promise.all(payloads.map(payload => writeJsonFile(target, payload)))

    const finalText = await fs.readFile(target, 'utf8')
    let parsed = null
    try { parsed = JSON.parse(finalText) } catch {}
    t.check('scenario concurrent write leaves parseable JSON', !!parsed, finalText.slice(0, 500))

    const matched = payloads.some(payload =>
      parsed &&
      parsed.writer === payload.writer &&
      parsed.label === payload.label &&
      Array.isArray(parsed.values) &&
      parsed.values.length === payload.values.length &&
      parsed.values.every((value, item) => value === payload.values[item])
    )
    t.check('scenario concurrent write leaves one complete payload', matched, JSON.stringify(parsed).slice(0, 500))

    const dirEntries = await fs.readdir(path.dirname(target))
    const leftoverTemps = dirEntries.filter(name => name.endsWith('.tmp'))
    t.check('scenario concurrent write cleans temp files', leftoverTemps.length === 0, JSON.stringify(leftoverTemps))

    const fallback = { ok: false }
    const diskValue = await readJsonFile(target, fallback)
    t.check('scenario readJsonFile reads final JSON after stress', diskValue !== fallback && typeof diskValue.writer === 'number', JSON.stringify(diskValue).slice(0, 500))
  } finally {
    data.cleanup()
  }
}

module.exports = { run }
