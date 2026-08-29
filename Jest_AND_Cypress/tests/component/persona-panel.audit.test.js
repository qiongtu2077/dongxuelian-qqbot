import { flushPromises, mount } from '@vue/test-utils'
import PersonaPanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/PersonaPanel.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  createLore: jest.fn(),
  createPersona: jest.fn(),
  deleteLore: jest.fn(),
  deletePersona: jest.fn(),
  deleteTtsClone: jest.fn(),
  fetchLoreList: jest.fn(),
  fetchLores: jest.fn(),
  fetchPersonaDetail: jest.fn(),
  fetchPersonaDiagnostics: jest.fn(),
  fetchPersonas: jest.fn(),
  fetchTtsVoices: jest.fn(),
  savePersonaVoice: jest.fn(),
  ttsClone: jest.fn(),
  ttsPreview: jest.fn(),
  updateLore: jest.fn(),
  updatePersona: jest.fn(),
  updateTtsClone: jest.fn(),
}))

const PERSONA = { name: '测试人格', description: '用于测试', type: 'custom' }
const LORE = { name: '测试世界', description: '用于测试', content: '世界观内容' }
const ADMIN_REQUIRED = { ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } }
const OriginalFileReader = global.FileReader
const originalMediaLoad = global.HTMLMediaElement.prototype.load
const originalCreateObjectURL = global.URL.createObjectURL
const originalRevokeObjectURL = global.URL.revokeObjectURL

// Completes clone-file reads with deterministic bytes.
class ImmediateFileReader {
  readAsDataURL() {
    this.result = 'data:audio/wav;base64,AA=='
    queueMicrotask(() => this.onload?.())
  }
}

// Supplies all harmless mount-time API responses.
function arrangePersonaReads() {
  dashboardApi.fetchPersonas.mockResolvedValue({ ok: true, data: [PERSONA] })
  dashboardApi.fetchLoreList.mockResolvedValue({ ok: true, data: [{ id: LORE.name, description: LORE.description }] })
  dashboardApi.fetchLores.mockResolvedValue({ ok: true, data: [LORE] })
  dashboardApi.fetchPersonaDiagnostics.mockResolvedValue({ ok: true, data: { summary: {}, documents: [] } })
  dashboardApi.fetchTtsVoices.mockResolvedValue({ ok: true, data: { builtin: ['冰糖'], personas: [], clonedVoices: [] } })
}

// Mounts the panel after persona, lore, diagnostics, and voice reads settle.
async function mountPersona(showAdminDialog = jest.fn()) {
  const wrapper = mount(PersonaPanel, { global: { provide: { showAdminDialog } } })
  await flushPromises()
  return wrapper
}

// Finds one card by its heading text.
function findCard(wrapper, title) {
  return wrapper.findAll('.card').find(card => card.find('h2').exists() && card.find('h2').text() === title)
}

// Selects the test persona in the voice card's first SelectBox.
async function selectVoicePersona(wrapper) {
  const voiceCard = findCard(wrapper, '语音合成配置')
  voiceCard.findComponent({ name: 'SelectBox' }).vm.$emit('update:modelValue', PERSONA.name)
  await flushPromises()
  return voiceCard
}

// Chooses one short audio file in the clone input.
async function chooseCloneFile(voiceCard) {
  const input = voiceCard.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', {
    value: [new File(['audio'], 'sample.wav', { type: 'audio/wav' })],
    configurable: true,
  })
  await input.trigger('change')
  await flushPromises()
}

// Finds the delete button for one named persona or lore row.
function findNamedDelete(wrapper, name) {
  const row = wrapper.findAll('.grp').find(item => item.text().includes(name))
  return row.findAll('button').find(button => button.text() === '删除')
}

describe('PersonaPanel 语音与删除按钮闭环', () => {
  beforeAll(() => {
    global.FileReader = ImmediateFileReader
    global.URL.createObjectURL = jest.fn(() => 'blob:test-audio')
    global.URL.revokeObjectURL = jest.fn()
    global.HTMLMediaElement.prototype.load = function loadMetadataImmediately() {
      Object.defineProperty(this, 'duration', { value: 1, configurable: true })
      queueMicrotask(() => this.onloadedmetadata?.())
    }
  })

  afterAll(() => {
    global.FileReader = OriginalFileReader
    global.HTMLMediaElement.prototype.load = originalMediaLoad
    if (originalCreateObjectURL) global.URL.createObjectURL = originalCreateObjectURL
    else delete global.URL.createObjectURL
    if (originalRevokeObjectURL) global.URL.revokeObjectURL = originalRevokeObjectURL
    else delete global.URL.revokeObjectURL
  })

  beforeEach(() => {
    jest.clearAllMocks()
    arrangePersonaReads()
    jest.spyOn(window, 'confirm').mockReturnValue(true)
  })

  test('普通试听管理员过期后只重试原请求并生成音频', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi.ttsPreview
      .mockResolvedValueOnce(ADMIN_REQUIRED)
      .mockResolvedValueOnce({ ok: true, data: { audio: 'AA==', mimeType: 'audio/wav' } })
    const wrapper = await mountPersona(showAdminDialog)
    const voiceCard = await selectVoicePersona(wrapper)

    await voiceCard.findAll('button').find(button => button.text() === '试听').trigger('click')
    await flushPromises()
    await resume()
    await flushPromises()

    expect(dashboardApi.ttsPreview).toHaveBeenCalledTimes(2)
    expect(voiceCard.find('audio').attributes('src')).toBe('blob:test-audio')
    wrapper.unmount()
  })

  test('普通试听管理员验证取消后不重试且恢复按钮', async () => {
    dashboardApi.ttsPreview.mockResolvedValue(ADMIN_REQUIRED)
    const wrapper = await mountPersona(jest.fn())
    const voiceCard = await selectVoicePersona(wrapper)

    await voiceCard.findAll('button').find(button => button.text() === '试听').trigger('click')
    await flushPromises()

    expect(dashboardApi.ttsPreview).toHaveBeenCalledTimes(1)
    expect(voiceCard.text()).not.toContain('合成中...')
    wrapper.unmount()
  })

  test('普通试听后端失败显示错误且不创建音频', async () => {
    dashboardApi.ttsPreview.mockResolvedValue({ ok: false, data: { message: '语音服务不可用' } })
    const wrapper = await mountPersona()
    const voiceCard = await selectVoicePersona(wrapper)

    await voiceCard.findAll('button').find(button => button.text() === '试听').trigger('click')
    await flushPromises()

    expect(voiceCard.text()).toContain('语音服务不可用')
    expect(voiceCard.find('audio').exists()).toBe(false)
    wrapper.unmount()
  })

  test('测试克隆管理员过期后复用已读取字节并成功', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi.ttsClone
      .mockResolvedValueOnce(ADMIN_REQUIRED)
      .mockResolvedValueOnce({ ok: true, data: { asset: { id: 'voice-1' } } })
    const wrapper = await mountPersona(showAdminDialog)
    const voiceCard = await selectVoicePersona(wrapper)
    await chooseCloneFile(voiceCard)

    await voiceCard.findAll('button').find(button => button.text() === '测试克隆').trigger('click')
    await flushPromises()
    await resume()
    await flushPromises()

    expect(dashboardApi.ttsClone).toHaveBeenCalledTimes(2)
    expect(dashboardApi.ttsClone.mock.calls[1][1]).toBe('AA==')
    expect(voiceCard.text()).toContain('克隆成功')
    wrapper.unmount()
  })

  test('测试克隆管理员验证取消后不重试且恢复按钮', async () => {
    dashboardApi.ttsClone.mockResolvedValue(ADMIN_REQUIRED)
    const wrapper = await mountPersona(jest.fn())
    const voiceCard = await selectVoicePersona(wrapper)
    await chooseCloneFile(voiceCard)

    await voiceCard.findAll('button').find(button => button.text() === '测试克隆').trigger('click')
    await flushPromises()

    expect(dashboardApi.ttsClone).toHaveBeenCalledTimes(1)
    expect(voiceCard.text()).toContain('等待管理员验证')
    expect(voiceCard.text()).not.toContain('克隆中...')
    wrapper.unmount()
  })

  test('测试克隆后端失败显示具体错误并结束加载', async () => {
    dashboardApi.ttsClone.mockResolvedValue({ ok: false, data: { message: '克隆模型失败' } })
    const wrapper = await mountPersona()
    const voiceCard = await selectVoicePersona(wrapper)
    await chooseCloneFile(voiceCard)

    await voiceCard.findAll('button').find(button => button.text() === '测试克隆').trigger('click')
    await flushPromises()

    expect(voiceCard.text()).toContain('克隆模型失败')
    expect(voiceCard.text()).toContain('克隆失败')
    wrapper.unmount()
  })

  test.each([
    { kind: '人格', name: PERSONA.name, api: 'deletePersona', prompt: '删除人格需要管理员密码' },
    { kind: '世界观', name: LORE.name, api: 'deleteLore', prompt: '删除世界观需要管理员密码' },
  ])('$kind 删除确认后管理员过期只重试原对象一次', async target => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi[target.api]
      .mockResolvedValueOnce(ADMIN_REQUIRED)
      .mockResolvedValueOnce({ ok: true, data: { message: '删除成功' } })
    const wrapper = await mountPersona(showAdminDialog)

    await findNamedDelete(wrapper, target.name).trigger('click')
    await flushPromises()
    await resume()
    await flushPromises()

    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(showAdminDialog).toHaveBeenCalledWith(target.prompt, expect.any(Function))
    expect(dashboardApi[target.api]).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  test.each([
    { kind: '人格', name: PERSONA.name, api: 'deletePersona' },
    { kind: '世界观', name: LORE.name, api: 'deleteLore' },
  ])('$kind 删除确认取消时不发送请求', async target => {
    window.confirm.mockReturnValue(false)
    const wrapper = await mountPersona()

    await findNamedDelete(wrapper, target.name).trigger('click')

    expect(dashboardApi[target.api]).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain(target.name)
    wrapper.unmount()
  })

  test.each([
    { kind: '人格', name: PERSONA.name, api: 'deletePersona' },
    { kind: '世界观', name: LORE.name, api: 'deleteLore' },
  ])('$kind 管理员验证取消后不重试且解除删除状态', async target => {
    dashboardApi[target.api].mockResolvedValue(ADMIN_REQUIRED)
    const wrapper = await mountPersona(jest.fn())

    await findNamedDelete(wrapper, target.name).trigger('click')
    await flushPromises()

    expect(dashboardApi[target.api]).toHaveBeenCalledTimes(1)
    expect(findNamedDelete(wrapper, target.name).text()).toBe('删除')
    wrapper.unmount()
  })

  test.each([
    { kind: '人格', name: PERSONA.name, api: 'deletePersona' },
    { kind: '世界观', name: LORE.name, api: 'deleteLore' },
  ])('$kind 删除后端失败时保留对象并显示错误', async target => {
    dashboardApi[target.api].mockResolvedValue({ ok: false, data: { message: `${target.kind}删除失败详情` } })
    const wrapper = await mountPersona()

    await findNamedDelete(wrapper, target.name).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain(`${target.kind}删除失败详情`)
    expect(wrapper.text()).toContain(target.name)
    wrapper.unmount()
  })
})
