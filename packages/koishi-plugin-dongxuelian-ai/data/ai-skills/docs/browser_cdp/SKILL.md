---
name: browser_cdp
kind: docs
description: 使用受控浏览器进行网页读取、调试、截图、PDF、DOM 检查和有限交互的工作流；按当前项目 browser_action 能力执行。
---

# Browser CDP Skill

本项目当前浏览器能力由 `browser_action` 提供，底层使用 Puppeteer 控制本地 Chrome/Edge/Chromium。它不是通用的外部 CDP 会话管理器，不能假装支持未实现的“连接任意浏览器”接口。

## 何时使用

- 搜索 API 结果质量差，需要用浏览器打开搜索页读取。
- 需要检查网页标题、正文、DOM、按钮、链接、截图或导出 PDF。
- 需要对网页进行有限交互，例如点击、输入、表单填写、滚动、等待元素出现。
- 需要查看控制台消息或网络请求摘要。

## 可用动作摘要

`browser_action` 支持的代表动作：

- 启停与导航：`start`、`stop`、`navigate`、`open`、`reload`、`back`、`forward`
- 页面读取：`title`、`text`、`snapshot`、`html`、`url`
- 交互：`click`、`type`、`fill_form`、`press`、`scroll`、`hover`、`focus`
- DOM 检查：`exists`、`count`、`get_attribute`、`extract`
- 输出：`screenshot`、`pdf`
- 调试：`console_messages`、`network_requests`
- 标签页和状态：`tabs`、`new_tab`、`switch_tab`、`close_tab`、`clear_cache`

## 安全边界

- 只能访问 http/https URL。
- 工具会拒绝 localhost、内网、保留地址和解析到内网的地址。
- `evaluate` 禁止访问 cookie、本地存储、剪贴板，禁止发起网络请求和动态执行不受控代码。
- 浏览器工具属于危险工具，Dashboard 下通常需要审批；QQ 默认不可用。

## 推荐流程

1. 先用 `web_search` 获取候选来源。
2. 若搜索结果混乱，再用 `browser_action` 的 `search_and_read` 或 `navigate` 打开可靠来源。
3. 用 `snapshot` 获取页面结构，必要时再 `text`、`extract` 或截图。
4. 只在用户明确需要时执行点击、输入、下载、上传。
5. 输出结论时注明信息来自工具读取结果，不要凭页面标题脑补正文。
