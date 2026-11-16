import { flushPromises, mount } from '@vue/test-utils'
import ParticipationControls from '../../../packages/koishi-plugin-dashboard/frontend/src/components/ParticipationControls.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  fetchParticipation: jest.fn(), saveParticipation: jest.fn(), fetchGroupNames: jest.fn(),
  importGroupNames: jest.fn(), saveGroupName: jest.fn(),
}))

describe('群开关名称展示', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    const policy = { version: 1, privateEnabled: false, groups: { 10001: true, 10002: false }, abusiveGroups: {} }
    dashboardApi.fetchParticipation.mockResolvedValue({ ok: true, data: { ok: true, policy } })
    dashboardApi.saveParticipation.mockResolvedValue({ ok: true, data: { ok: true, policy } })
    dashboardApi.fetchGroupNames.mockResolvedValue({ ok: true, data: { ok: true, groups: { 10001: '真实测试群 <名称>' } } })
    dashboardApi.importGroupNames.mockResolvedValue({ ok: true, data: { ok: true, groups: { 10001: '真实测试群 <名称>', 10002: '' } } })
    dashboardApi.saveGroupName.mockImplementation(async (id, name) => ({ ok: true, data: { ok: true, groups: { 10001: '真实测试群 <名称>', 10002: '', [id]: name } } }))
  })

  test('群名在群号后显示并安全转义，切换仍提交原始群号', async () => {
    const wrapper = mount(ParticipationControls, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const rows = wrapper.findAll('.participation-group-number')
    expect(rows[0].text()).toBe('10001')
    expect(wrapper.find('input[aria-label="群 10001 名称"]').element.value).toBe('真实测试群 <名称>')
    expect(rows[1].text()).toBe('10002')
    expect(rows[0].find('名称').exists()).toBe(false)
    await wrapper.find('#participation-group-id').setValue('10001')
    expect(wrapper.find('.participation-group-editor').text()).toContain('真实测试群 <名称>')
    await wrapper.find('input[aria-label="群 10001 总开关"]').setValue(false)
    await flushPromises()
    expect(dashboardApi.saveParticipation).toHaveBeenCalledWith({ kind: 'group', groupId: '10001', enabled: false })
    expect(dashboardApi.importGroupNames).toHaveBeenCalledTimes(1)
    expect(dashboardApi.importGroupNames).toHaveBeenCalledWith(['10002'])
    wrapper.unmount()
  })

  test('QQ 离线仍显示群号且不阻止群开关操作', async () => {
    dashboardApi.fetchGroupNames.mockResolvedValue({ ok: false, data: { message: 'QQ 离线' } })
    dashboardApi.importGroupNames.mockResolvedValue({ ok: true, data: { ok: true, groups: { 10001: '', 10002: '' }, message: '群名读取失败，请手动填写名称' } })
    const wrapper = mount(ParticipationControls, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    expect(wrapper.findAll('.participation-group-number').map(row => row.text())).toEqual(['10001', '10002'])
    expect(wrapper.find('input[aria-label="群 10001 总开关"]').element.disabled).toBe(false)
    wrapper.unmount()
  })

  test('编辑、保存和重新挂载保留本地名称，已有名称不再导入', async () => {
    dashboardApi.fetchGroupNames.mockResolvedValue({ ok: true, data: { ok: true, groups: { 10001: '旧名称', 10002: '' } } })
    const wrapper = mount(ParticipationControls, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    expect(dashboardApi.importGroupNames).not.toHaveBeenCalled()
    await wrapper.find('input[aria-label="群 10001 名称"]').setValue('我的备注')
    await wrapper.find('button[aria-label="保存群 10001 名称"]').trigger('click')
    await flushPromises()
    expect(dashboardApi.saveGroupName).toHaveBeenCalledWith('10001', '我的备注')
    expect(wrapper.text()).toContain('群名已保存')
    expect(dashboardApi.saveParticipation).not.toHaveBeenCalled()
    wrapper.unmount()
    dashboardApi.fetchGroupNames.mockResolvedValue({ ok: true, data: { ok: true, groups: { 10001: '我的备注', 10002: '' } } })
    const reloaded = mount(ParticipationControls, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    expect(reloaded.find('input[aria-label="群 10001 名称"]').element.value).toBe('我的备注')
    expect(dashboardApi.importGroupNames).not.toHaveBeenCalled()
    reloaded.unmount()
  })

  test('保存失败保留草稿，重试成功后更新名称', async () => {
    dashboardApi.saveGroupName.mockResolvedValueOnce({ ok: false, data: { message: '磁盘写入失败' } })
    const wrapper = mount(ParticipationControls, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const input = wrapper.find('input[aria-label="群 10001 名称"]')
    await input.setValue('新的备注')
    await input.trigger('keydown.enter')
    await flushPromises()
    expect(wrapper.text()).toContain('磁盘写入失败')
    expect(input.element.value).toBe('新的备注')
    expect(wrapper.find('button[aria-label="保存群 10001 名称"]').exists()).toBe(true)
    await wrapper.find('button[aria-label="保存群 10001 名称"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('群名已保存')
    wrapper.unmount()
  })

  test('新加入群读取一次名称，其他行未保存的草稿保留', async () => {
    dashboardApi.fetchGroupNames.mockResolvedValue({ ok: true, data: { ok: true, groups: { 10001: '旧名称', 10002: '' } } })
    dashboardApi.saveParticipation.mockResolvedValue({ ok: true, data: { ok: true, policy: { version: 1, privateEnabled: false, groups: { 10001: true, 10002: false, 10003: true }, abusiveGroups: {} } } })
    dashboardApi.importGroupNames.mockResolvedValue({ ok: true, data: { ok: true, groups: { 10001: '旧名称', 10002: '', 10003: '新群' } } })
    const wrapper = mount(ParticipationControls, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    await wrapper.find('input[aria-label="群 10001 名称"]').setValue('尚未保存')
    await wrapper.find('#participation-group-id').setValue('10003')
    await wrapper.find('input[aria-label="所填群号的总开关"]').setValue(true)
    await flushPromises()
    expect(dashboardApi.importGroupNames).toHaveBeenCalledWith(['10003'])
    expect(wrapper.find('input[aria-label="群 10003 名称"]').element.value).toBe('新群')
    expect(wrapper.find('input[aria-label="群 10001 名称"]').element.value).toBe('尚未保存')
    wrapper.unmount()
  })
})
