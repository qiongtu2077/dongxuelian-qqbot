const fs = require('node:fs')
const path = require('node:path')

const workspaceRoot = path.resolve(__dirname, '..', '..', '..')

// 读取仓库中的真实源码，供前后端契约交叉检查。
function readSource(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8')
}

// 按稳定的函数声明边界截取源码，避免 Windows 换行符影响审查断言。
function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  if (startIndex < 0 || endIndex < 0) return ''
  return source.slice(startIndex, endIndex)
}

describe('主控制台前后端契约审查', () => {
  test('已确认：Fallback 后端返回 defaults，ConfigPanel 却读取 default', () => {
    const backend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/settings.ts')
    const frontend = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ConfigPanel.vue')

    expect(backend).toMatch(/defaults:\s*DEFAULT_FALLBACK_CHAINS/)
    expect(frontend).toMatch(/fRes\.data\.default\s*\|\|\s*\{\}/)
    expect(frontend).not.toMatch(/fRes\.data\.defaults\s*\|\|\s*\{\}/)
  })

  test('已确认：诊断测试和正常启动共用同一个 startBot 写接口', () => {
    const api = readSource('packages/koishi-plugin-dashboard/frontend/src/api.ts')
    const control = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ControlPanel.vue')

    expect(api).toMatch(/startBot\(\).*post\('\/bot\/start'/)
    expect(control).toMatch(/async function testStartBot\(\)[\s\S]*?await startBot\(\)/)
    expect(control).toMatch(/async function doStart\(\)[\s\S]*?await startBot\(\)/)
  })

  test('已确认：主模型兜底开关没有对应后端配置字段', () => {
    const frontend = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ConfigPanel.vue')
    const settings = readSource('packages/koishi-plugin-dashboard/src/lib/routes/settings.ts')

    expect(frontend).toContain("const LIGHTWEIGHT_MAIN_TOGGLE_KEY = 'cfg_lightweight_main'")
    expect(settings).not.toContain('cfg_lightweight_main')
    expect(settings).not.toContain('useMainFallback')
  })

  test('已确认：人格、世界观和黑白名单删除入口没有确认调用', () => {
    const persona = readSource('packages/koishi-plugin-dashboard/frontend/src/components/PersonaPanel.vue')
    const whitelist = readSource('packages/koishi-plugin-dashboard/frontend/src/components/WhitelistPanel.vue')
    const personaDeleteBody = persona.match(/async function doPersonaDelete[\s\S]*?\n\s*}\n\s*\n\s*function resetLoreForm/)?.[0] || ''
    const loreDeleteBody = persona.match(/async function doLoreDelete[\s\S]*?\n\s*}\n\s*\n\s*const voicePersona/)?.[0] || ''
    const whitelistDeleteBody = whitelist.match(/async function removeDisplayItem[\s\S]*?\n\s*}\n\s*\n\s*return \{/)?.[0] || ''

    expect(personaDeleteBody).not.toMatch(/confirm\s*\(/)
    expect(loreDeleteBody).not.toMatch(/confirm\s*\(/)
    expect(whitelistDeleteBody).not.toMatch(/confirm\s*\(/)
  })

  test('已确认：新增 API 配置分三次写入，后续失败没有恢复前序写入', () => {
    const keyManager = readSource('packages/koishi-plugin-dashboard/frontend/src/components/KeyManager.vue')
    const saveProviderBody = sourceBetween(keyManager, 'async function saveProvider()', 'function fallbackModelOptions')

    expect(saveProviderBody).toMatch(/await saveCustomProviders\(/)
    expect(saveProviderBody).toMatch(/await updateKey\(/)
    expect(saveProviderBody).toMatch(/await saveFallbackChains\(/)
    expect(saveProviderBody).not.toMatch(/rollback|restore|snapshot|transaction/i)
  })

  test('已确认：API Keys 三张排序卡的任一保存按钮都会写入全部链', () => {
    const keyManager = readSource('packages/koishi-plugin-dashboard/frontend/src/components/KeyManager.vue')
    const saveFallbackBody = sourceBetween(keyManager, 'async function saveFallback()', 'async function loadUsage')

    expect(keyManager).toMatch(/v-for="card in fallbackCards"[\s\S]*?@click="saveFallback"/)
    expect(saveFallbackBody).toMatch(/for \(const card of FALLBACK_CARDS\)/)
    expect(saveFallbackBody).toMatch(/saveFallbackChains\(chains\)/)
  })

  test('已确认：部署进度后端要求管理员令牌，但前端请求不携带且失败后永久继续轮询', () => {
    const api = readSource('packages/koishi-plugin-dashboard/frontend/src/api.ts')
    const deployPanel = readSource('packages/koishi-plugin-dashboard/frontend/src/components/DeployPanel.vue')
    const deployBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/deploy.ts')
    const pollBody = sourceBetween(deployPanel, 'function pollProgress(taskId: string)', 'function uploadCookie')

    expect(deployBackend).toMatch(/function handleGetDeployProgress[\s\S]*?requireAdmin\(req, res\)/)
    expect(api).toMatch(/getDeployProgress\(taskId: string\).*return get\('\/deploy\/progress\/' \+ encodeURIComponent\(taskId\)\)/)
    expect(api).not.toMatch(/getDeployProgress\(taskId: string\).*return get\('\/deploy\/progress\/' \+ encodeURIComponent\(taskId\), true\)/)
    expect(pollBody).toContain('if (!res.ok) return')
    expect(pollBody).not.toMatch(/setTimeout|timeout|ADMIN_REQUIRED|isAdminRequired/)
  })

  test('已确认：管理员密码验证的 401 与访问令牌失效共用全局退出处理', () => {
    const api = readSource('packages/koishi-plugin-dashboard/frontend/src/api.ts')
    const authBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/auth.ts')

    expect(authBackend).toMatch(/admin password is incorrect' }, 401/)
    expect(api).toMatch(/verifyAdmin\(password: string\).*return post<[^>]+>\('\/admin\/verify'/)
    expect(api).toMatch(/function handle401[\s\S]*?removeItem\('dashboard_token'\)[\s\S]*?auth-expired/)
  })

  test('已确认：修改任一种密码都会使访问令牌失效，但成功页不会立即退出', () => {
    const settingsPanel = readSource('packages/koishi-plugin-dashboard/frontend/src/components/SettingsPanel.vue')
    const authBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/auth.ts')

    expect((authBackend.match(/rotateSessionSecret\(\)/g) || [])).toHaveLength(2)
    expect(settingsPanel).not.toContain("localStorage.removeItem('dashboard_token')")
    expect(settingsPanel).not.toContain("dispatchEvent(new Event('auth-expired'))")
  })

  test('已确认：图集三类写操作缺少管理员验证后的重试分支', () => {
    const gallery = readSource('packages/koishi-plugin-dashboard/frontend/src/components/GalleryPanel.vue')

    expect(gallery).toMatch(/await uploadGalleryImage\(/)
    expect(gallery).toMatch(/await deleteGalleryImage\(/)
    expect(gallery).toMatch(/await updateGalleryImageStyle\(/)
    expect(gallery).not.toMatch(/ADMIN_REQUIRED|isAdminRequired|showAdminDialog/)
  })

  test('已确认：资源维护、stale 回收和取消任务缺少管理员验证后的重试分支', () => {
    const resource = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ResourcePanel.vue')
    const maintenanceBody = sourceBetween(resource, 'async function toggleMaintenance()', 'async function reclaimStale')
    const reclaimBody = sourceBetween(resource, 'async function reclaimStale()', 'async function setMode')
    const cancelBody = sourceBetween(resource, 'async function cancelTask(task: JsonRecord)', 'onMounted(() =>')

    expect(maintenanceBody).toMatch(/setResourceMaintenance\(/)
    expect(reclaimBody).toMatch(/reclaimResourceStale\(/)
    expect(cancelBody).toMatch(/cancelResourceTask\(/)
    expect(maintenanceBody + reclaimBody + cancelBody).not.toMatch(/ADMIN_REQUIRED|isAdminRequired|showAdminDialog/)
  })

  test('已确认：普通 TTS 试听和测试克隆缺少管理员验证后的重试分支', () => {
    const persona = readSource('packages/koishi-plugin-dashboard/frontend/src/components/PersonaPanel.vue')
    const previewBody = sourceBetween(persona, 'async function doPreview()', 'function onCloneFileChange')
    const cloneBody = sourceBetween(persona, 'async function doClone()', 'async function doPreviewAsset')

    expect(previewBody).toMatch(/await ttsPreview\(/)
    expect(cloneBody).toMatch(/await ttsClone\(/)
    expect(previewBody).not.toMatch(/ADMIN_REQUIRED|isAdminRequired|showAdminDialog/)
    expect(cloneBody).not.toMatch(/ADMIN_REQUIRED|isAdminRequired|showAdminDialog/)
  })

  test('已确认：Fallback 保存接口没有校验链条内部结构', () => {
    const settings = readSource('packages/koishi-plugin-dashboard/src/lib/routes/settings.ts')
    const handlerBody = sourceBetween(settings, 'function handlePutFallback', 'function handleGetAdminIds')

    expect(handlerBody).toMatch(/if \(!isRecord\(chains\)\)/)
    expect(handlerBody).toMatch(/JSON\.stringify\(chains, null, 2\)/)
    expect(handlerBody).not.toMatch(/provider.*model|model.*provider|normalize.*fallback|validate.*fallback/i)
  })

  test('已确认：更换 QQ 号会改写配置并立即重启，但按钮仍叫“重载配置”', () => {
    const control = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ControlPanel.vue')
    const botBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/bot.ts')

    expect(control).toMatch(/@click="saveSelfId"[\s\S]*?'重载配置'/)
    expect(botBackend).toMatch(/function handlePutQqSelfId[\s\S]*?writeFileSync\(ymlPath[\s\S]*?restart\.sh/)
  })
})
