'use strict'

const path = require('path')
const release = require('../packages/koishi-plugin-dashboard/lib/release')

// Verifies one explicit release directory and prints only non-sensitive release metadata.
function main(argv = process.argv.slice(2)) {
  const releaseRoot = path.resolve(String(argv[0] || ''))
  if (!argv[0]) throw new Error('usage: verify-release-manifest.js <release-dir>')
  const manifest = release.verifyReleaseManifest(releaseRoot)
  process.stdout.write(JSON.stringify({ ok: true, releaseId: manifest.releaseId, manifestHash: manifest.manifestHash, contentHash: manifest.contentHash, files: manifest.files.length }) + '\n')
}

if (require.main === module) {
  try { main() } catch (error) {
    process.stderr.write(String(error && error.message || error) + '\n')
    process.exit(1)
  }
}

module.exports = { main }
