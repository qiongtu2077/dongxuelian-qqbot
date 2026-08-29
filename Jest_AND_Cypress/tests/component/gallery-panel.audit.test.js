import { flushPromises, mount } from '@vue/test-utils'
import GalleryPanel from '../../../packages/koishi-plugin-dashboard/frontend/src/components/GalleryPanel.vue'
import * as dashboardApi from '../../../packages/koishi-plugin-dashboard/frontend/src/api'

jest.mock('../../../packages/koishi-plugin-dashboard/frontend/src/api', () => ({
  deleteGalleryImage: jest.fn(),
  fetchGalleryImages: jest.fn(),
  isAdminRequired: jest.fn(res => res?.code === 'ADMIN_REQUIRED' || res?.data?.code === 'ADMIN_REQUIRED'),
  updateGalleryImageStyle: jest.fn(),
  uploadGalleryImage: jest.fn(),
}))

const INITIAL_IMAGE = { id: 'image-1', name: '莲莲.png', url: '/gallery/image-1', foilStyle: null }
const ADMIN_REQUIRED = { ok: false, code: 'ADMIN_REQUIRED', data: { code: 'ADMIN_REQUIRED' } }
const OriginalFileReader = global.FileReader
const OriginalImage = global.Image

// Supplies deterministic browser file reads for upload retry tests.
class ImmediateFileReader {
  readAsDataURL() {
    this.result = 'data:image/png;base64,AA=='
    queueMicrotask(() => this.onload?.())
  }
}

// Completes image preloading without making a network request.
class ImmediateImage {
  set src(_value) { queueMicrotask(() => this.onload?.()) }
}

// Mounts one populated gallery after its initial read finishes.
async function mountGallery(showAdminDialog = jest.fn()) {
  const wrapper = mount(GalleryPanel, { global: { provide: { showAdminDialog } } })
  await flushPromises()
  return wrapper
}

// Sends one image through the hidden file input.
async function chooseUpload(wrapper) {
  const input = wrapper.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', {
    value: [new File(['image'], 'new.png', { type: 'image/png' })],
    configurable: true,
  })
  await input.trigger('change')
  await flushPromises()
}

// Selects the only image and invokes the bulk-delete button.
async function invokeBulkDelete(wrapper) {
  await wrapper.find('button[title="批量删除"]').trigger('click')
  await wrapper.find('article.gallery-card').trigger('click')
  await wrapper.findAll('button').find(button => button.text() === '删除选中').trigger('click')
  await flushPromises()
}

// Opens the only image and chooses foil style B.
async function invokeStyleUpdate(wrapper) {
  await wrapper.find('article.gallery-card').trigger('click')
  await wrapper.find('button[title="闪卡样式 B"]').trigger('click')
  await flushPromises()
}

describe('GalleryPanel 管理员重试闭环', () => {
  beforeAll(() => {
    global.FileReader = ImmediateFileReader
    global.Image = ImmediateImage
  })

  afterAll(() => {
    global.FileReader = OriginalFileReader
    global.Image = OriginalImage
  })

  beforeEach(() => {
    jest.clearAllMocks()
    dashboardApi.fetchGalleryImages.mockResolvedValue({ ok: true, data: { images: [INITIAL_IMAGE] } })
    jest.spyOn(window, 'confirm').mockReturnValue(true)
  })

  test('上传遇到管理员过期时只重试原文件并成功加入图集', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi.uploadGalleryImage
      .mockResolvedValueOnce(ADMIN_REQUIRED)
      .mockResolvedValueOnce({ ok: true, data: { image: { ...INITIAL_IMAGE, id: 'image-2', name: 'new.png' } } })
    const wrapper = await mountGallery(showAdminDialog)

    await chooseUpload(wrapper)
    expect(showAdminDialog).toHaveBeenCalledWith('上传图集图片需要管理员密码', expect.any(Function))
    await resume()
    await flushPromises()

    expect(dashboardApi.uploadGalleryImage).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('图片已加入莲莲图集')
    wrapper.unmount()
  })

  test('上传管理员验证取消后不重试且恢复按钮状态', async () => {
    const showAdminDialog = jest.fn()
    dashboardApi.uploadGalleryImage.mockResolvedValue(ADMIN_REQUIRED)
    const wrapper = await mountGallery(showAdminDialog)

    await chooseUpload(wrapper)

    expect(dashboardApi.uploadGalleryImage).toHaveBeenCalledTimes(1)
    expect(wrapper.find('button[title="上传图片"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  test('上传后端失败显示错误并重新读取真实图集', async () => {
    dashboardApi.uploadGalleryImage.mockResolvedValue({ ok: false, data: { message: '上传被拒绝' } })
    const wrapper = await mountGallery()

    await chooseUpload(wrapper)

    expect(wrapper.text()).toContain('上传被拒绝')
    expect(dashboardApi.fetchGalleryImages).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  test('批量删除管理员过期后复用已确认的图片编号并成功删除', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi.deleteGalleryImage
      .mockResolvedValueOnce(ADMIN_REQUIRED)
      .mockResolvedValueOnce({ ok: true, data: { deleted: [{ id: INITIAL_IMAGE.id }] } })
    const wrapper = await mountGallery(showAdminDialog)

    await invokeBulkDelete(wrapper)
    await resume()
    await flushPromises()

    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(dashboardApi.deleteGalleryImage).toHaveBeenNthCalledWith(2, [INITIAL_IMAGE.id])
    expect(wrapper.text()).not.toContain(INITIAL_IMAGE.name)
    wrapper.unmount()
  })

  test('批量删除管理员验证取消后保留图片且恢复加载状态', async () => {
    dashboardApi.deleteGalleryImage.mockResolvedValue(ADMIN_REQUIRED)
    const wrapper = await mountGallery(jest.fn())

    await invokeBulkDelete(wrapper)

    expect(dashboardApi.deleteGalleryImage).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('article.gallery-card')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('删除中...')
    wrapper.unmount()
  })

  test('批量删除后端失败不移除图片并显示具体错误', async () => {
    dashboardApi.deleteGalleryImage.mockResolvedValue({ ok: false, data: { message: '图片正在使用' } })
    const wrapper = await mountGallery()

    await invokeBulkDelete(wrapper)

    expect(wrapper.text()).toContain('图片正在使用')
    expect(wrapper.findAll('article.gallery-card')).toHaveLength(1)
    wrapper.unmount()
  })

  test('样式保存管理员过期后只重试原图片和样式', async () => {
    let resume
    const showAdminDialog = jest.fn((_message, callback) => { resume = callback })
    dashboardApi.updateGalleryImageStyle
      .mockResolvedValueOnce(ADMIN_REQUIRED)
      .mockResolvedValueOnce({ ok: true, data: { image: { ...INITIAL_IMAGE, foilStyle: 'B' } } })
    const wrapper = await mountGallery(showAdminDialog)

    await invokeStyleUpdate(wrapper)
    await resume()
    await flushPromises()

    expect(dashboardApi.updateGalleryImageStyle).toHaveBeenNthCalledWith(2, INITIAL_IMAGE.id, 'B')
    expect(wrapper.find('.gallery-preview-card').classes()).toContain('gallery-card--foil-b')
    wrapper.unmount()
  })

  test('样式管理员验证取消后不重试且重新启用样式按钮', async () => {
    dashboardApi.updateGalleryImageStyle.mockResolvedValue(ADMIN_REQUIRED)
    const wrapper = await mountGallery(jest.fn())

    await invokeStyleUpdate(wrapper)

    expect(dashboardApi.updateGalleryImageStyle).toHaveBeenCalledTimes(1)
    expect(wrapper.find('button[title="闪卡样式 B"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  test('样式保存后端失败保留原样式并显示错误', async () => {
    dashboardApi.updateGalleryImageStyle.mockResolvedValue({ ok: false, data: { message: '样式保存失败详情' } })
    const wrapper = await mountGallery()

    await invokeStyleUpdate(wrapper)

    expect(wrapper.text()).toContain('样式保存失败详情')
    expect(wrapper.find('.gallery-preview-card').classes()).not.toContain('gallery-card--foil-b')
    wrapper.unmount()
  })
})
