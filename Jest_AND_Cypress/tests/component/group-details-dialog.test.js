import { flushPromises, mount } from '@vue/test-utils'
import ParticipationControls from '../../../packages/koishi-plugin-dashboard/frontend/src/components/ParticipationControls.vue'
import * as api from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  fetchParticipation: jest.fn(), saveParticipation: jest.fn(), fetchGroupNames: jest.fn(),
  importGroupNames: jest.fn(), saveGroupName: jest.fn(), addManagedGroup: jest.fn(),
  fetchGroupSettings: jest.fn(), saveGroupSettings: jest.fn(), deleteManagedGroup: jest.fn(),
}))

let policy
let settings
let showAdminDialog
let wrapper

// 挂载真实列表并通过编辑按钮打开真实详情弹窗。
async function openDetails() {
  wrapper = mount(ParticipationControls, { attachTo: document.body, global: { provide: { showAdminDialog }, stubs: { teleport: true } } })
  await flushPromises()
  await wrapper.find('button[aria-label="编辑群 10001"]').trigger('click')
  await flushPromises()
}

describe('群详情编辑与删除', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    showAdminDialog = jest.fn()
    policy = { version: 1, privateEnabled: true, groups: { 10001: true, 10002: false }, abusiveGroups: {} }
    settings = { groupId: '10001', name: '测试群', enabled: true, abusiveEnabled: false, randomEnabled: false, repeatEnabled: true, videoEnabled: true, collectionEnabled: true, summaryUnlimited: false, politicalEnabled: false, persona: '', randomRate: null, voiceRate: null }
    api.fetchParticipation.mockResolvedValue({ ok: true, data: { policy } })
    api.fetchGroupNames.mockResolvedValue({ ok: true, data: { groups: { 10001: '测试群', 10002: '其他群' } } })
    api.fetchGroupSettings.mockResolvedValue({ ok: true, data: { settings, personas: ['测试人格'], defaults: { randomRate: 0.008, voiceRate: 0.1 } } })
    api.saveGroupSettings.mockImplementation(async draft => ({ ok: true, data: { settings: draft, policy: { ...policy, groups: { ...policy.groups, 10001: draft.enabled }, abusiveGroups: { 10001: draft.abusiveEnabled } }, groups: { 10001: draft.name, 10002: '其他群' } } }))
    api.deleteManagedGroup.mockResolvedValue({ ok: true, data: { policy: { ...policy, groups: { 10002: false }, abusiveGroups: {} }, groups: { 10002: '其他群' } } })
  })

  afterEach(() => { wrapper?.unmount(); wrapper = null })

  test('编辑按钮打开对应群，保存完整草稿后同步该群且保留其他群草稿', async () => {
    await openDetails()
    expect(api.fetchGroupSettings).toHaveBeenCalledWith('10001')
    expect(wrapper.findAll('.participation-group-row input[role="switch"]')).toHaveLength(2)
    expect(wrapper.findAll('[role="dialog"] input[role="switch"]')).toHaveLength(8)
    expect(wrapper.text()).not.toMatch(/已开启|已关闭/)
    await wrapper.find('input[aria-label="群 10002 名称"]').setValue('其他群未保存')
    await wrapper.find('input[aria-label="群 10001 详情名称"]').setValue('新群名')
    await wrapper.find('#group-detail-abusiveEnabled').setValue(true)
    await wrapper.find('#group-detail-enabled').setValue(false)
    await wrapper.find('#group-detail-randomEnabled').setValue(true)
    await wrapper.find('select[aria-label="群人格"]').setValue('测试人格')
    await wrapper.find('input[aria-label="主动回复基础概率（%）"]').setValue('0')
    await wrapper.find('input[aria-label="随机语音概率（%）"]').setValue('100')
    await wrapper.find('[role="dialog"] form').trigger('submit')
    await flushPromises()
    expect(api.saveGroupSettings).toHaveBeenCalledWith({ ...settings, name: '新群名', enabled: false, abusiveEnabled: true, randomEnabled: true, persona: '测试人格', randomRate: 0, voiceRate: 1 })
    expect(wrapper.find('input[aria-label="群 10001 名称"]').element.value).toBe('新群名')
    expect(wrapper.find('input[aria-label="群 10002 名称"]').element.value).toBe('其他群未保存')
    expect(wrapper.find('input[aria-label="群 10001 总开关"]').element.checked).toBe(false)
    expect(wrapper.find('input[aria-label="全局私聊开关"]').element.checked).toBe(true)
    expect(wrapper.text()).toContain('群详情已保存')
  })

  test('保存失败不更新列表，保留草稿；概率清空时发送 null', async () => {
    api.saveGroupSettings.mockResolvedValue({ ok: false, data: { message: '磁盘写入失败' } })
    await openDetails()
    await wrapper.find('input[aria-label="群 10001 详情名称"]').setValue('草稿名称')
    const rate = wrapper.find('input[aria-label="主动回复基础概率（%）"]')
    await rate.setValue('20')
    await rate.setValue('')
    await wrapper.find('[role="dialog"] form').trigger('submit')
    await flushPromises()
    expect(api.saveGroupSettings).toHaveBeenCalledWith(expect.objectContaining({ randomRate: null }))
    expect(wrapper.text()).toContain('磁盘写入失败')
    expect(wrapper.find('input[aria-label="群 10001 详情名称"]').element.value).toBe('草稿名称')
    expect(wrapper.find('input[aria-label="群 10001 名称"]').element.value).toBe('测试群')
  })

  test('详情读取失败时不能提交默认值，可重新加载', async () => {
    api.fetchGroupSettings.mockResolvedValueOnce({ ok: false, data: { message: '详情读取失败' } })
    await openDetails()
    expect(wrapper.text()).toContain('详情读取失败')
    expect(wrapper.find('[role="dialog"] form').exists()).toBe(false)
    await wrapper.findAll('button').find(button => button.text() === '重新加载').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"] form').exists()).toBe(true)
    expect(api.saveGroupSettings).not.toHaveBeenCalled()
  })

  test('管理员验证后重试原始保存草稿', async () => {
    api.saveGroupSettings.mockResolvedValueOnce({ ok: false, code: 'ADMIN_REQUIRED', data: {} })
    await openDetails()
    await wrapper.find('input[aria-label="群 10001 详情名称"]').setValue('待验证草稿')
    await wrapper.find('[role="dialog"] form').trigger('submit')
    await flushPromises()
    expect(showAdminDialog).toHaveBeenCalledTimes(1)
    await showAdminDialog.mock.calls[0][1]()
    await flushPromises()
    expect(api.saveGroupSettings).toHaveBeenLastCalledWith(expect.objectContaining({ name: '待验证草稿' }))
    expect(wrapper.find('input[aria-label="群 10001 名称"]').element.value).toBe('待验证草稿')
  })

  test('删除须二次确认，取消和 Escape 均不发请求，确认后才移除对应群', async () => {
    await openDetails()
    await wrapper.find('.group-detail-danger button').trigger('click')
    expect(wrapper.find('[role="alertdialog"]').text()).toContain('测试群（10001）')
    expect(api.deleteManagedGroup).not.toHaveBeenCalled()
    expect(document.activeElement.textContent).toBe('取消')
    await wrapper.find('[role="alertdialog"] button').trigger('click')
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
    await wrapper.find('.group-detail-danger button').trigger('click')
    await wrapper.find('[role="alertdialog"]').trigger('keydown', { key: 'Escape' })
    expect(api.deleteManagedGroup).not.toHaveBeenCalled()
    await wrapper.find('.group-detail-danger button').trigger('click')
    await wrapper.find('[role="alertdialog"] .danger-button').trigger('click')
    await flushPromises()
    expect(api.deleteManagedGroup).toHaveBeenCalledWith('10001')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.findAll('.participation-group-number').map(item => item.text())).toEqual(['10002'])
    expect(wrapper.find('input[aria-label="全局私聊开关"]').element.checked).toBe(true)
  })

  test('删除失败保留确认弹窗和列表，重试成功才关闭', async () => {
    api.deleteManagedGroup.mockResolvedValueOnce({ ok: false, data: { message: '删除失败' } })
    await openDetails()
    await wrapper.find('.group-detail-danger button').trigger('click')
    await wrapper.find('[role="alertdialog"] .danger-button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alertdialog"]').text()).toContain('删除失败')
    expect(wrapper.findAll('.participation-group-row')).toHaveLength(2)
    await wrapper.find('[role="alertdialog"] .danger-button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
  })
})
