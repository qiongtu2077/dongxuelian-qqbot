const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { ROOT } = require('../fake/file')

function findShell() {
  for (const shell of ['bash', 'sh']) {
    const result = spawnSync(shell, ['-c', 'exit 0'], { stdio: 'pipe' })
    if (!result.error && result.status === 0) return shell
  }
  return null
}

function cleanup(dir) {
  if (!dir) return
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
}

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function readJson(file) {
  return JSON.parse(read(file))
}

function hasFiles(dir) {
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0
}

function outputOf(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function isInsideDirectory(target, root) {
  const targetReal = fs.realpathSync(target)
  const rootReal = fs.realpathSync(root)
  const relative = path.relative(rootReal, targetReal)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function runSetup(shell, env) {
  const setupScript = path.relative(ROOT, path.join(ROOT, 'setup.sh')).replace(/\\/g, '/')
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ')
  return spawnSync(shell, ['-c', `${assignments} ${shell} ${shellQuote(setupScript)}`], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  })
}

async function run(t) {
  t.section('scenario: setup.sh simulated install')

  const shell = findShell()
  if (!shell) {
    t.skip('scenario setup simulation', 'setup simulation requires bash/sh')
    return
  }

  const setupScript = path.relative(ROOT, path.join(ROOT, 'setup.sh')).replace(/\\/g, '/')
  const syntax = spawnSync(shell, ['-n', setupScript], { cwd: ROOT, encoding: 'utf8' })
  t.check('scenario setup shell syntax passes before simulation', syntax.status === 0, outputOf(syntax))

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dongxuelian-setup-test-'))
  const outsideKoishiDir = path.join(os.tmpdir(), `dongxuelian-setup-escape-koishi-${process.pid}-${Date.now()}`)
  const outsideNapcatDir = path.join(os.tmpdir(), `dongxuelian-setup-escape-napcat-${process.pid}-${Date.now()}`)
  try {
    const koishiDir = path.join(tempRoot, 'koishi-app')
    const dataDir = path.join(koishiDir, 'data')
    const napcatDir = path.join(tempRoot, 'Napcat')
    const result = runSetup(shell, {
      SETUP_MODE: 'simulate-files',
      QQ_NUMBER: '123456',
      ADMIN_QQ: '100000000',
      SETUP_TEST_ROOT: tempRoot,
      KOISHI_DIR: koishiDir,
      DATA_DIR: dataDir,
      NAPCAT_DIR: napcatDir,
      REPO_ROOT: ROOT,
    })
    const output = outputOf(result)
    t.check('scenario setup simulation exits successfully', result.status === 0, output)
    t.check('scenario setup simulation skips real install steps', [
      'Installing system dependencies',
      'Running NapCat installer',
      'Installing npm dependencies',
      'Starting Koishi',
    ].every(text => !output.includes(text)), output)

    const koishiYml = read(path.join(koishiDir, 'koishi.yml'))
    t.check('scenario setup koishi selfId written', koishiYml.includes("selfId: '123456'"), koishiYml)
    t.check('scenario setup koishi onebot endpoint written', koishiYml.includes('ws://127.0.0.1:8080/onebot/v11/ws'), koishiYml)
    for (const pluginKey of ['group-name-at', 'dongxuelian-help', 'dongxuelian-ai', 'dongxuelian-poke', 'koishi-plugin-defense', 'local-video-sender', 'group-leave-notice']) {
      t.check(`scenario setup koishi includes ${pluginKey}`, koishiYml.includes(`${pluginKey}:`), koishiYml)
    }

    const napcatConfigDir = path.join(napcatDir, 'opt', 'QQ', 'resources', 'app', 'app_launcher', 'napcat', 'config')
    const napcat = readJson(path.join(napcatConfigDir, 'napcat.json'))
    const onebot = readJson(path.join(napcatConfigDir, 'onebot11_123456.json'))
    t.check('scenario setup napcat webui port written', napcat.webui && napcat.webui.port === 6099, JSON.stringify(napcat))
    t.check('scenario setup onebot websocket port written', onebot.network.websocketServers[0].port === 8080, JSON.stringify(onebot))

    for (const dir of ['conversations', 'user-profiles', 'ai-event-dumps', 'political-handlers']) {
      t.check(`scenario setup data dir exists: ${dir}`, fs.existsSync(path.join(dataDir, dir)))
    }
    for (const file of ['ai-provider.txt', 'ai-model.txt', 'ai-base-url.txt', 'ai-repeat-enabled.json', 'ai-enable-search.txt', 'ai-enable-thinking.txt', 'ai-admin-ids.json']) {
      t.check(`scenario setup runtime file exists: ${file}`, fs.existsSync(path.join(dataDir, file)))
    }
    const adminIds = readJson(path.join(dataDir, 'ai-admin-ids.json'))
    t.check('scenario setup admin ids includes primary admin', adminIds.includes('100000000'), JSON.stringify(adminIds))
    t.check('scenario setup admin ids includes secondary admin', adminIds.includes('200000000'), JSON.stringify(adminIds))
    for (const skillPart of ['core', 'personas', 'modes', 'lore']) {
      const dir = path.join(dataDir, 'ai-skills', skillPart)
      t.check(`scenario setup skill dir populated: ${skillPart}`, hasFiles(dir), dir)
    }

    for (const outputPath of [koishiDir, dataDir, napcatDir, path.join(koishiDir, 'koishi.yml'), path.join(napcatConfigDir, 'napcat.json')]) {
      t.check('scenario setup output path stays under temp root', isInsideDirectory(outputPath, tempRoot), outputPath)
    }

    const escape = runSetup(shell, {
      SETUP_MODE: 'simulate-files',
      QQ_NUMBER: '123456',
      ADMIN_QQ: '100000000',
      SETUP_TEST_ROOT: tempRoot,
      KOISHI_DIR: outsideKoishiDir,
      DATA_DIR: path.join(tempRoot, 'safe-data'),
      NAPCAT_DIR: path.join(tempRoot, 'safe-napcat'),
      REPO_ROOT: ROOT,
    })
    const escapeOutput = outputOf(escape)
    t.check('scenario setup rejects escaped koishi output path', escape.status !== 0 && escapeOutput.includes('escapes SETUP_TEST_ROOT'), escapeOutput)
    t.check('scenario setup escape does not write koishi config outside temp root', !fs.existsSync(path.join(outsideKoishiDir, 'koishi.yml')), outsideKoishiDir)

    const napcatEscape = runSetup(shell, {
      SETUP_MODE: 'simulate-files',
      QQ_NUMBER: '123456',
      ADMIN_QQ: '100000000',
      SETUP_TEST_ROOT: tempRoot,
      KOISHI_DIR: path.join(tempRoot, 'safe-koishi'),
      DATA_DIR: path.join(tempRoot, 'safe-data'),
      NAPCAT_DIR: outsideNapcatDir,
      REPO_ROOT: ROOT,
    })
    const napcatEscapeOutput = outputOf(napcatEscape)
    t.check('scenario setup rejects escaped napcat output path', napcatEscape.status !== 0 && napcatEscapeOutput.includes('escapes SETUP_TEST_ROOT'), napcatEscapeOutput)
    t.check('scenario setup escape does not write napcat config outside temp root', !fs.existsSync(path.join(outsideNapcatDir, 'opt')), outsideNapcatDir)
  } finally {
    cleanup(tempRoot)
    cleanup(outsideKoishiDir)
    cleanup(outsideNapcatDir)
  }
}

module.exports = { run }
