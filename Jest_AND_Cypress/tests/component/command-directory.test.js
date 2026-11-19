import { flushPromises, mount } from '@vue/test-utils'
import CommandBrowser from '../../../packages/koishi-plugin-dashboard/frontend/src/components/CommandBrowser.vue'
import { fetchCommands, fetchFeatures } from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({ fetchCommands: jest.fn(), fetchFeatures: jest.fn() }))

beforeEach(() => {
  fetchFeatures.mockResolvedValue({ ok: true, data: [{ id: 'daily', title: '群聊日报', summary: '摘要', detail: '详细说明', usage: '查看报告', related: ['other'] }, { id: 'other', title: '群设置', summary: '设置', detail: '详情' }] })
  fetchCommands.mockResolvedValue({ ok: true, data: [{ category: '常用', commands: [{ cmd: '群聊日报', desc: '生成日报' }, { cmd: '其它', desc: '测试' }] }] })
})

test('同一搜索查询功能和指令，清除查询后展开关联目标', async () => {
  const page = mount(CommandBrowser, { attachTo: document.body })
  HTMLElement.prototype.scrollIntoView = jest.fn()
  await flushPromises()
  await page.get('input').setValue('群聊日报')
  expect(page.findAll('.feature-card')).toHaveLength(1)
  expect(page.get('.command-definitions').text()).toContain('生成日报')
  expect(page.get('.command-definitions').text()).not.toContain('其它')
  await page.get('#feat-daily button').trigger('click')
  await page.get('.related-features button').trigger('click')
  expect(page.get('input').element.value).toBe('')
  expect(page.get('#feat-other').classes()).toContain('expanded')
  expect(fetchCommands).toHaveBeenCalledTimes(1)
  expect(fetchFeatures).toHaveBeenCalledTimes(1)
  page.unmount()
})

test.each(['commands', 'features'])('单侧失败仍显示另一来源，重试只读取失败的来源：%s', async side => {
  const failing = side === 'commands' ? fetchCommands : fetchFeatures
  const other = side === 'commands' ? fetchFeatures : fetchCommands
  failing.mockRejectedValueOnce(new Error('fixture'))
  const page = mount(CommandBrowser)
  await flushPromises()
  expect(page.get('[role=alert]').text()).toContain('暂不可用')
  expect(page.text()).toContain(side === 'commands' ? '群聊日报' : '生成日报')
  await page.get('[role=alert] button').trigger('click')
  await flushPromises()
  expect(page.find('[role=alert]').exists()).toBe(false)
  expect(other).toHaveBeenCalledTimes(1)
  page.unmount()
})
