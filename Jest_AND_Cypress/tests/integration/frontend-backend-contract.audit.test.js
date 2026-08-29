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
  test('Fallback 前后端统一使用 defaults 字段', () => {
    const backend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/settings.ts')
    const frontend = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ConfigPanel.vue')

    expect(backend).toMatch(/defaults:\s*DEFAULT_FALLBACK_CHAINS/)
    expect(frontend).toMatch(/fRes\.data\.defaults\s*\|\|\s*\{\}/)
    expect(frontend).not.toMatch(/fRes\.data\.default\s*\|\|\s*\{\}/)
  })

  test('诊断启动入口已删除，只保留正常启动调用', () => {
    const api = readSource('packages/koishi-plugin-dashboard/frontend/src/api.ts')
    const control = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ControlPanel.vue')

    expect(api).toMatch(/startBot\(\).*post\('\/bot\/start'/)
    expect(control).toMatch(/async function doStart\(\)[\s\S]*?await startBot\(\)/)
    expect(control).not.toMatch(/testStartBot|测试 startBot API/)
  })

  test('无效主模型兜底浏览器状态已删除', () => {
    const frontend = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ConfigPanel.vue')
    const settings = readSource('packages/koishi-plugin-dashboard/src/lib/routes/settings.ts')

    expect(frontend).not.toContain('cfg_lightweight_main')
    expect(frontend).not.toContain('useMainFallback')
    expect(settings).not.toContain('cfg_lightweight_main')
    expect(settings).not.toContain('useMainFallback')
  })

  test('人格、世界观和黑白名单删除都先确认准确对象', () => {
    const persona = readSource('packages/koishi-plugin-dashboard/frontend/src/components/PersonaPanel.vue')
    const whitelist = readSource('packages/koishi-plugin-dashboard/frontend/src/components/WhitelistPanel.vue')
    const personaDeleteBody = sourceBetween(persona, 'async function doPersonaDelete', 'function resetLoreForm')
    const loreDeleteBody = sourceBetween(persona, 'async function doLoreDelete', 'const voicePersona')
    const whitelistDeleteBody = sourceBetween(whitelist, 'async function removeDisplayItem', 'return {')

    expect(personaDeleteBody).toMatch(/window\.confirm/)
    expect(loreDeleteBody).toMatch(/window\.confirm/)
    expect(whitelistDeleteBody).toMatch(/window\.confirm/)
  })

  test('新增 API 配置只调用一次完整事务接口并在成功后回读', () => {
    const keyManager = readSource('packages/koishi-plugin-dashboard/frontend/src/components/KeyManager.vue')
    const saveProviderBody = sourceBetween(keyManager, 'async function saveProvider(', 'async function loadUsage')

    expect(saveProviderBody).toMatch(/await saveApiConfigTransaction\(/)
    expect(saveProviderBody).toMatch(/await reloadSavedApiConfig\(/)
    expect(saveProviderBody).not.toMatch(/await saveCustomProviders\(|await updateKey\(|await saveFallbackChains\(/)
  })

  test('备用链编辑只存在于模型配置页的单一保存入口', () => {
    const keyManager = readSource('packages/koishi-plugin-dashboard/frontend/src/components/KeyManager.vue')
    const configPanel = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ConfigPanel.vue')

    expect(keyManager).not.toMatch(/v-for="card in fallbackCards"|async function saveFallback\(/)
    expect((configPanel.match(/保存全部备用链/g) || [])).toHaveLength(1)
    expect(configPanel).toMatch(/saveFallbackChains\(chains\)/)
  })

  test('部署进度携带管理员令牌并使用有界、非重叠轮询', () => {
    const api = readSource('packages/koishi-plugin-dashboard/frontend/src/api.ts')
    const deployPanel = readSource('packages/koishi-plugin-dashboard/frontend/src/components/DeployPanel.vue')
    const deployBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/deploy.ts')
    const pollBody = sourceBetween(deployPanel, 'function clearProgressPolling()', 'function uploadCookie')

    expect(deployBackend).toMatch(/function handleGetDeployProgress[\s\S]*?requireAdmin\(req, res\)/)
    expect(api).toMatch(/getDeployProgress\(taskId: string\).*return get\('\/deploy\/progress\/' \+ encodeURIComponent\(taskId\), true\)/)
    expect(pollBody).toMatch(/code === 'ADMIN_REQUIRED'/)
    expect(pollBody).toMatch(/progressNetworkFailures >= 3/)
    expect(pollBody).toMatch(/setTimeout/)
    expect(pollBody).not.toMatch(/setInterval/)
  })

  test('管理员密码错误使用 403，只有普通 401 触发全局退出', () => {
    const api = readSource('packages/koishi-plugin-dashboard/frontend/src/api.ts')
    const authBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/auth.ts')

    expect(authBackend).toMatch(/admin password is incorrect'[\s\S]*?ADMIN_PASSWORD_INCORRECT'[\s\S]*?403/)
    expect(api).toMatch(/verifyAdmin\(password: string\).*return post<[^>]+>\('\/admin\/verify'/)
    expect(api).toMatch(/function clearDashboardSession[\s\S]*?removeItem\('dashboard_token'\)[\s\S]*?auth-expired/)
    expect(api).toMatch(/function handle401[\s\S]*?res\.status === 401[\s\S]*?clearDashboardSession\(\)/)
  })

  test('修改任一种密码成功后立即清理两层会话', () => {
    const settingsPanel = readSource('packages/koishi-plugin-dashboard/frontend/src/components/SettingsPanel.vue')
    const authBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/auth.ts')

    expect((authBackend.match(/rotateSessionSecret\(\)/g) || [])).toHaveLength(2)
    expect((settingsPanel.match(/clearDashboardSession\('密码已修改，请重新登录'\)/g) || [])).toHaveLength(2)
  })

  test('图集三类写操作都有单次管理员验证重试', () => {
    const gallery = readSource('packages/koishi-plugin-dashboard/frontend/src/components/GalleryPanel.vue')

    expect(gallery).toMatch(/await uploadGalleryImage\(/)
    expect(gallery).toMatch(/await deleteGalleryImage\(/)
    expect(gallery).toMatch(/await updateGalleryImageStyle\(/)
    expect(gallery).toMatch(/isAdminRequired\(res\)/)
    expect(gallery).toMatch(/showAdminDialog\('上传图集图片需要管理员密码'/)
    expect(gallery).toMatch(/showAdminDialog\('批量删除图集图片需要管理员密码'/)
    expect(gallery).toMatch(/showAdminDialog\('保存图集闪卡样式需要管理员密码'/)
  })

  test('资源维护、stale 回收和取消任务都有管理员验证闭环', () => {
    const resource = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ResourcePanel.vue')
    const maintenanceBody = sourceBetween(resource, 'async function toggleMaintenance', 'async function reclaimStale')
    const reclaimBody = sourceBetween(resource, 'async function reclaimStale', 'async function setMode')
    const cancelBody = sourceBetween(resource, 'async function cancelTask', 'onMounted(() =>')

    expect(maintenanceBody).toMatch(/setResourceMaintenance\(/)
    expect(reclaimBody).toMatch(/reclaimResourceStale\(/)
    expect(cancelBody).toMatch(/cancelResourceTask\(/)
    expect(maintenanceBody + reclaimBody + cancelBody).toMatch(/ADMIN_REQUIRED|isAdminRequired|showAdminDialog/)
    expect(maintenanceBody).toMatch(/retried/)
    expect(reclaimBody).toMatch(/retried/)
    expect(cancelBody).toMatch(/retried/)
  })

  test('普通 TTS 试听和测试克隆复用已读内容完成管理员重试', () => {
    const persona = readSource('packages/koishi-plugin-dashboard/frontend/src/components/PersonaPanel.vue')
    const previewBody = sourceBetween(persona, 'async function doPreview', 'function onCloneFileChange')
    const cloneBody = sourceBetween(persona, 'async function submitCloneUpload', 'async function doPreviewAsset')

    expect(previewBody).toMatch(/await ttsPreview\(/)
    expect(cloneBody).toMatch(/await ttsClone\(/)
    expect(previewBody).toMatch(/ADMIN_REQUIRED|isAdminRequired|showAdminDialog/)
    expect(cloneBody).toMatch(/ADMIN_REQUIRED|isAdminRequired|showAdminDialog/)
    expect(cloneBody).toMatch(/submitCloneUpload\(base64, mimeType, personaName, metadata, true\)/)
  })

  test('Fallback 保存接口统一执行严格的三链引用校验', () => {
    const settings = readSource('packages/koishi-plugin-dashboard/src/lib/routes/settings.ts')
    const handlerBody = sourceBetween(settings, 'function handlePutFallback', 'function handleGetAdminIds')

    expect(handlerBody).toMatch(/normalizeFallbackChains\(chains\)/)
    expect(settings).toMatch(/引用未知供应商/)
    expect(settings).toMatch(/引用供应商未登记模型/)
    expect(settings).toMatch(/Key 文件名无效/)
  })

  test('更换 QQ 号文案、原子写、重启和健康检查语义一致', () => {
    const control = readSource('packages/koishi-plugin-dashboard/frontend/src/components/ControlPanel.vue')
    const botBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/bot.ts')

    expect(control).toMatch(/@click="saveSelfId\(\)"[\s\S]*?更换 QQ 号并重启机器人/)
    expect(control).toMatch(/window\.confirm\([\s\S]*?短暂离线/)
    expect(botBackend).toMatch(/function writeConfigAtomic[\s\S]*?renameSync\(nextPath, filePath\)/)
    expect(botBackend).toMatch(/function handlePutQqSelfId[\s\S]*?writeConfigAtomic\(ymlPath, nextYml\)[\s\S]*?机器人已通过重启健康检查/)
  })

  test('普通发布不携带 B 站 cookies，执行入口只接受已确认预览', () => {
    const deployBackend = readSource('packages/koishi-plugin-dashboard/src/lib/routes/deploy.ts')
    const release = readSource('packages/koishi-plugin-dashboard/src/lib/release.ts')
    const api = readSource('packages/koishi-plugin-dashboard/frontend/src/api.ts')

    expect(deployBackend).toMatch(/'POST \/dashboard\/api\/deploy\/preview': handlePostDeployPreview/)
    expect(deployBackend).toMatch(/'POST \/dashboard\/api\/deploy\/run': handlePostSafeDeployRun/)
    expect(deployBackend).toMatch(/validateRemoteReleasePreview\([\s\S]*?previewId: input\.previewId[\s\S]*?confirmed: input\.confirmed/)
    expect(api).toMatch(/previewDeploy\(data: unknown\).*post\('\/deploy\/preview', data, true/)
    expect(deployBackend).not.toMatch(/scpCommand\([^\n]*bilibili-cookies\.txt/)
    expect(release).not.toContain('bilibili-cookies.txt')
  })

  test('远端预览完整校验当前清单并冻结提交、基线和有效期', () => {
    const remoteRelease = readSource('packages/koishi-plugin-dashboard/src/lib/remote-release.ts')
    const deployHelpers = readSource('packages/koishi-plugin-dashboard/src/lib/deploy-helpers.ts')

    expect(remoteRelease).toMatch(/git'[\s\S]*?'status'[\s\S]*?'--porcelain=v1'/)
    expect(remoteRelease).toMatch(/verify-release-manifest\.js/)
    expect(remoteRelease).toMatch(/PREVIEW_TTL_MS = 30 \* 60 \* 1000/)
    expect(remoteRelease).toMatch(/compareRemoteBaseline/)
    expect(deployHelpers).toContain('StrictHostKeyChecking=accept-new')
    expect(deployHelpers).not.toContain('StrictHostKeyChecking=no')
    expect(remoteRelease).not.toContain("createHash('md5')")
  })
})
