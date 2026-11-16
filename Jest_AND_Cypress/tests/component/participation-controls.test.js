import { flushPromises, mount } from '@vue/test-utils'
import ParticipationControls from '../../../packages/koishi-plugin-dashboard/frontend/src/components/ParticipationControls.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  fetchParticipation: jest.fn(), saveParticipation: jest.fn(), fetchGroupNames: jest.fn(),
}))

describe('群开关名称展示', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    const policy = { version: 1, privateEnabled: false, groups: { 10001: true, 10002: false }, abusiveGroups: {} }
    dashboardApi.fetchParticipation.mockResolvedValue({ ok: true, data: { ok: true, policy } })
    dashboardApi.saveParticipation.mockResolvedValue({ ok: true, data: { ok: true, policy } })
    dashboardApi.fetchGroupNames.mockResolvedValue({ ok: true, data: { ok: true, groups: { 10001: '真实测试群 <名称>' } } })
  })

  test('群名在群号后显示并安全转义，切换仍提交原始群号', async () => {
    const wrapper = mount(ParticipationControls, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    const rows = wrapper.findAll('.participation-group-number')
    expect(rows[0].text()).toBe('10001 · 真实测试群 <名称>')
    expect(rows[1].text()).toBe('10002')
    expect(rows[0].find('名称').exists()).toBe(false)
    await wrapper.find('#participation-group-id').setValue('10001')
    expect(wrapper.find('.participation-group-editor').text()).toContain('真实测试群 <名称>')
    await wrapper.find('input[aria-label="群 10001 总开关"]').setValue(false)
    await flushPromises()
    expect(dashboardApi.saveParticipation).toHaveBeenCalledWith({ kind: 'group', groupId: '10001', enabled: false })
    wrapper.unmount()
  })

  test('QQ 离线仍显示群号且不阻止群开关操作', async () => {
    dashboardApi.fetchGroupNames.mockResolvedValue({ ok: false, data: { message: 'QQ 离线' } })
    const wrapper = mount(ParticipationControls, { global: { provide: { showAdminDialog: jest.fn() } } })
    await flushPromises()
    expect(wrapper.findAll('.participation-group-number').map(row => row.text())).toEqual(['10001', '10002'])
    expect(wrapper.find('input[aria-label="群 10001 总开关"]').element.disabled).toBe(false)
    wrapper.unmount()
  })
})
