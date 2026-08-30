const { LIVE_ADMIN_PASSWORD } = require('./runtime')
const { apiMock, jsonResponse } = require('./mock-api')

/** Installs request interception for Dashboard and Agent Console API calls. */
async function installApiMock(page) {
  await page.setRequestInterception(true)
  page.on('request', async request => {
    const url = new URL(request.url())
    if (url.pathname === '/agent/' || url.pathname === '/agent') {
      return request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head><title>Mock Agent Console</title></head><body><main>Mock Agent Console</main></body></html>',
      })
    }
    if (!url.pathname.startsWith('/dashboard/api')) return request.continue()
    const pathname = url.pathname.replace('/dashboard/api', '') || '/'
    const method = request.method()
    let parsedBody = null
    try { parsedBody = request.postData() ? JSON.parse(request.postData()) : null } catch { /* non-critical: mock handlers tolerate non-JSON bodies */ }
    try {
      const response = apiMock(method, pathname, { searchParams: url.searchParams, body: parsedBody })
      const isWrite = method !== 'GET'
      if (isWrite) await new Promise(resolve => setTimeout(resolve, 80))
      await request.respond(response)
    } catch (error) {
      await request.respond(jsonResponse({ ok: false, message: error.message }, 500))
    }
  })
}

/** Waits until visible page text contains the expected value. */
async function waitForText(page, text, timeout = 8000) {
  await page.waitForFunction(value => document.body && document.body.innerText.includes(value), { timeout }, text)
}

/** Waits until a selected element contains the expected text. */
async function waitForTextInSelector(page, selector, text, timeout = 8000) {
  await page.waitForFunction(({ sel, value }) => {
    const el = document.querySelector(sel)
    return !!(el && el.innerText && el.innerText.includes(value))
  }, { timeout }, { sel: selector, value: text })
}

/** Waits until a selected element no longer contains the text. */
async function waitForTextNotInSelector(page, selector, text, timeout = 8000) {
  await page.waitForFunction(({ sel, value }) => {
    const el = document.querySelector(sel)
    return !!(el && el.innerText && !el.innerText.includes(value))
  }, { timeout }, { sel: selector, value: text })
}

/** Checks whether the current page contains visible matching text. */
async function hasText(page, text) {
  return page.evaluate(value => !!(document.body && document.body.innerText.includes(value)), text)
}

/** Waits until a form field exposes the expected value. */
async function waitForFieldValue(page, text, timeout = 8000) {
  await page.waitForFunction(value => {
    return [...document.querySelectorAll('input,textarea,select')].some(el => String(el.value || '').includes(value))
  }, { timeout }, text)
}

/** Waits until an input contains the expected value. */
async function waitForInputValue(page, text, timeout = 8000) {
  await waitForFieldValue(page, text, timeout)
}

/** Waits until a selector resolves to a visible element. */
async function waitForVisibleSelector(page, selector, timeout = 8000) {
  await page.waitForFunction(sel => {
    return [...document.querySelectorAll(sel)].some(el => {
      const box = el.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    })
  }, { timeout }, selector)
}

/** Clicks the visible element whose text matches the requested label. */
async function clickText(page, text, selector = 'button,a') {
  await page.waitForFunction((value, sel) => {
    return [...document.querySelectorAll(sel)].some(el => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && el.textContent.includes(value)
    })
  }, { timeout: 8000 }, text, selector)
  const rect = await page.evaluate((value, sel) => {
    const el = [...document.querySelectorAll(sel)].find(item => {
      const box = item.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && item.textContent.includes(value)
    })
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const scrolledBox = el.getBoundingClientRect()
    return { x: scrolledBox.left + scrolledBox.width / 2, y: scrolledBox.top + scrolledBox.height / 2 }
  }, text, selector)
  await new Promise(resolve => setTimeout(resolve, 80))
  await page.mouse.click(rect.x, rect.y)
}

/** Clicks the first visible element matching a selector. */
async function clickVisibleSelector(page, selector) {
  await waitForVisibleSelector(page, selector)
  const rect = await page.evaluate(sel => {
    const el = [...document.querySelectorAll(sel)].find(item => {
      const box = item.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    })
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const box = el.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  }, selector)
  if (!rect) throw new Error(`selector not visible: ${selector}`)
  await page.mouse.click(rect.x, rect.y)
}

/** Expands the Dashboard sidebar when it is collapsed. */
async function ensureSidebarExpanded(page) {
  const hasExpandedNav = await page.$('.sidebar-nav .sidebar-item')
  if (hasExpandedNav) return
  await page.waitForSelector('.sidebar-toggle', { timeout: 8000 })
  await page.click('.sidebar-toggle')
  await page.waitForSelector('.sidebar-nav .sidebar-item', { timeout: 8000 })
}

/** Collapses the Dashboard sidebar when it is expanded. */
async function ensureSidebarCollapsed(page) {
  const hasExpandedNav = await page.$('.sidebar-nav .sidebar-item')
  if (!hasExpandedNav) return
  await page.waitForSelector('.sidebar-toggle', { timeout: 8000 })
  await page.click('.sidebar-toggle')
  await page.waitForFunction(() => !document.querySelector('.sidebar-nav .sidebar-item'), { timeout: 8000 })
}

/** Opens a Dashboard sidebar tab by its label. */
async function clickSidebarTab(page, label) {
  await ensureSidebarExpanded(page)
  await page.waitForFunction(value => {
    return [...document.querySelectorAll('.sidebar-nav .sidebar-item')].some(el => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && el.textContent.includes(value)
    })
  }, { timeout: 8000 }, label)
  const clickTarget = value => {
    const el = [...document.querySelectorAll('.sidebar-nav .sidebar-item')].find(item => item.textContent.includes(value))
    if (!el) return false
    el.click()
    return true
  }
  const clicked = await page.evaluate(clickTarget, label)
  if (!clicked) throw new Error(`sidebar tab not found: ${label}`)
  await new Promise(resolve => setTimeout(resolve, 250))
  const active = await page.evaluate(value => {
    const labelEl = document.querySelector('.active-view-label')
    return !!(labelEl && labelEl.textContent.includes(value))
  }, label)
  if (!active) await page.evaluate(clickTarget, label)
  await page.waitForFunction(value => {
    const labelEl = document.querySelector('.active-view-label')
    return labelEl && labelEl.textContent.includes(value)
  }, { timeout: 8000 }, label)
}

/** Opens a sidebar tab and verifies the target route. */
async function clickSidebarTabExpectNavigation(page, label, pathname) {
  await ensureSidebarExpanded(page)
  await page.waitForFunction(value => {
    return [...document.querySelectorAll('.sidebar-nav .sidebar-item')].some(el => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && el.textContent.includes(value)
    })
  }, { timeout: 8000 }, label)
  const navigationPromise = page.waitForFunction(expected => window.location.pathname === expected, { timeout: 8000 }, pathname)
  const clicked = await page.evaluate(value => {
    const el = [...document.querySelectorAll('.sidebar-nav .sidebar-item')].find(item => item.textContent.includes(value))
    if (!el) return false
    el.click()
    return true
  }, label)
  if (!clicked) throw new Error(`sidebar tab not found: ${label}`)
  await navigationPromise
}

/** Clicks a named button within a card identified by its heading. */
async function clickButtonInCard(page, cardHeading, buttonText) {
  await page.waitForFunction((heading, text) => {
    const cards = [...document.querySelectorAll('.card')]
    return cards.some(card =>
      card.innerText.includes(heading) &&
      [...card.querySelectorAll('button')].some(button => button.textContent.includes(text))
    )
  }, { timeout: 8000 }, cardHeading, buttonText)
  const clicked = await page.evaluate((heading, text) => {
    const card = [...document.querySelectorAll('.card')].find(item => item.innerText.includes(heading))
    if (!card) return false
    const button = [...card.querySelectorAll('button')].find(item => item.textContent.includes(text))
    if (!button) return false
    button.scrollIntoView({ block: 'center', inline: 'center' })
    button.click()
    return true
  }, cardHeading, buttonText)
  if (!clicked) throw new Error(`button not found: ${cardHeading} / ${buttonText}`)
}

/** Clicks a named button in the block containing the expected text. */
async function clickButtonNearText(page, blockText, buttonText) {
  await page.waitForFunction((needle, text) => {
    return [...document.querySelectorAll('button')].some(button => {
      if (!button.textContent.includes(text)) return false
      let node = button.parentElement
      while (node && node !== document.body) {
        if (node.innerText && node.innerText.includes(needle)) return true
        node = node.parentElement
      }
      return false
    })
  }, { timeout: 8000 }, blockText, buttonText)
  const clicked = await page.evaluate((needle, text) => {
    const button = [...document.querySelectorAll('button')].find(item => {
      if (!item.textContent.includes(text)) return false
      let node = item.parentElement
      while (node && node !== document.body) {
        if (node.innerText && node.innerText.includes(needle)) return true
        node = node.parentElement
      }
      return false
    })
    if (!button) return false
    button.scrollIntoView({ block: 'center', inline: 'center' })
    button.click()
    return true
  }, blockText, buttonText)
  if (!clicked) throw new Error(`button near text not found: ${blockText} / ${buttonText}`)
}

/** Clicks a visible button by its accessible label. */
async function clickButtonByLabel(page, label) {
  await page.waitForFunction(value => {
    return [...document.querySelectorAll('button')].some(button =>
      button.getAttribute('aria-label') === value || button.getAttribute('title') === value
    )
  }, { timeout: 8000 }, label)
  const clicked = await page.evaluate(value => {
    const button = [...document.querySelectorAll('button')].find(item =>
      item.getAttribute('aria-label') === value || item.getAttribute('title') === value
    )
    if (!button) return false
    button.scrollIntoView({ block: 'center', inline: 'center' })
    button.click()
    return true
  }, label)
  if (!clicked) throw new Error(`button label not found: ${label}`)
}

/** Completes the administrator challenge when the modal is visible. */
async function verifyAdminIfVisible(page) {
  const visible = await hasText(page, '请输入管理员密码')
  if (!visible) return
  if (!LIVE_ADMIN_PASSWORD) throw new Error('admin dialog is visible but DASHBOARD_SMOKE_ADMIN_PASSWORD is not set')
  const inputHandle = await page.evaluateHandle(() => {
    const inputs = [...document.querySelectorAll('input')]
    return inputs.find(input => input.offsetParent && (input.placeholder || '').includes('管理员')) ||
      inputs.find(input => input.offsetParent && input.type === 'password') ||
      inputs.find(input => input.offsetParent)
  })
  const input = inputHandle.asElement()
  if (!input) throw new Error('admin password input not found')
  await input.click({ clickCount: 3 })
  await input.type(LIVE_ADMIN_PASSWORD)
  await clickText(page, '确认')
  await page.waitForFunction(() => !document.body.innerText.includes('请输入管理员密码'), { timeout: 10000 })
}

/** Types a value into the visible input identified by its placeholder. */
async function typePlaceholder(page, placeholder, value) {
  await page.waitForSelector(`input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`, { timeout: 8000 })
  const selector = `input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`
  await page.click(selector, { clickCount: 3 })
  await page.type(selector, value)
}

/** Selects an option from the currently visible select control. */
async function selectOptionValue(page, optionValue) {
  const labelByValue = {
    dashscope: 'DashScope',
    deepseek: 'DeepSeek',
    'qwen-vl-plus': 'Qwen VL',
    'deepseek-chat': 'DeepSeek Chat',
    '测试人格': '测试人格',
    '普通人格': '普通人格',
    __cloned__: '克隆音色',
    voice_asset_a: '测试音色',
  }
  const changed = await page.evaluate(value => {
    const select = [...document.querySelectorAll('select')].find(item =>
      [...item.options].some(option => option.value === value)
    )
    if (!select) return false
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, optionValue)
  if (changed) return
  const label = labelByValue[optionValue] || optionValue
  const picked = await page.evaluate(async ({ value, labelText }) => {
    const waitFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))
    const wraps = [...document.querySelectorAll('.sb-wrap')].filter(wrap => {
      const box = wrap.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && !wrap.classList.contains('disabled')
    })
    for (const wrap of wraps) {
      const trigger = wrap.querySelector('.sb-trigger')
      if (!trigger) continue
      trigger.click()
      await waitFrame()
      const options = [...wrap.querySelectorAll('.sb-opt')]
      const option = options.find(item => item.textContent.trim() === labelText || item.textContent.includes(labelText) || item.textContent.includes(value))
      if (option) {
        option.click()
        return true
      }
      trigger.click()
      await waitFrame()
    }
    return false
  }, { value: optionValue, labelText: label })
  if (!picked) throw new Error(`select option not found: ${optionValue}`)
}

/** Waits for a select option to appear or disappear. */
async function waitForSelectBoxOption(page, label, shouldExist = true) {
  await page.waitForFunction(async ({ labelText, expected }) => {
    const waitFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))
    const nativeExists = [...document.querySelectorAll('select option')].some(option => option.value === labelText || option.textContent.includes(labelText))
    let customExists = false
    const wraps = [...document.querySelectorAll('.sb-wrap')].filter(wrap => {
      const box = wrap.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && !wrap.classList.contains('disabled')
    })
    for (const wrap of wraps) {
      const trigger = wrap.querySelector('.sb-trigger')
      if (!trigger) continue
      trigger.click()
      await waitFrame()
      if ([...wrap.querySelectorAll('.sb-opt')].some(option => option.textContent.includes(labelText))) customExists = true
      trigger.click()
      await waitFrame()
      if (customExists) break
    }
    return expected ? (nativeExists || customExists) : !(nativeExists || customExists)
  }, { timeout: 8000 }, { labelText: label, expected: shouldExist })
}

/** Waits until the select control shows the expected label. */
async function waitForSelectBoxLabel(page, label) {
  await page.waitForFunction(labelText => {
    if ([...document.querySelectorAll('select')].some(select => select.value === labelText || select.selectedOptions[0]?.textContent.includes(labelText))) return true
    return [...document.querySelectorAll('.sb-trigger')].some(trigger => {
      const box = trigger.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && trigger.textContent.includes(labelText)
    })
  }, { timeout: 8000 }, label)
}

/** Verifies that the administrator modal can be cancelled. */
async function verifyAdminModalCancel(page) {
  await waitForVisibleSelector(page, '.admin-modal-card')
  await page.waitForFunction(() => {
    const modal = document.querySelector('.admin-modal-card')
    if (!modal) return false
    const box = modal.getBoundingClientRect()
    const style = getComputedStyle(modal)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && modal.innerText.includes('管理员密码')
  }, { timeout: 8000 })
  await clickText(page, '取消', '.admin-modal-card button')
  await page.waitForFunction(() => !document.querySelector('.admin-modal-card'), { timeout: 8000 })
}


module.exports = {
  installApiMock,
  waitForText,
  waitForTextInSelector,
  waitForTextNotInSelector,
  hasText,
  waitForFieldValue,
  waitForInputValue,
  waitForVisibleSelector,
  clickText,
  clickVisibleSelector,
  ensureSidebarExpanded,
  ensureSidebarCollapsed,
  clickSidebarTab,
  clickSidebarTabExpectNavigation,
  clickButtonInCard,
  clickButtonNearText,
  clickButtonByLabel,
  verifyAdminIfVisible,
  typePlaceholder,
  selectOptionValue,
  waitForSelectBoxOption,
  waitForSelectBoxLabel,
  verifyAdminModalCancel,
}
