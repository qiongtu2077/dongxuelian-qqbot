---
name: browser_visible
kind: docs
description: 浏览器可视化/截图核验工作流。当前项目没有常驻可见浏览器参数，使用 browser_action 的截图、PDF、snapshot 替代可视检查。
---

# Browser Visible Skill

本项目当前 `browser_action` 默认以受控 headless 模式启动浏览器，没有对外暴露 `headed=true`、自定义浏览器参数或连接用户可见浏览器的配置。不要声称已经打开了用户能看见的浏览器窗口。

## 当前可用替代方式

- `screenshot`：保存当前页面截图，用于视觉核验。
- `pdf`：把当前页面导出为 PDF。
- `set_viewport` / `resize`：切换桌面或移动端视口。
- `snapshot`：读取标题、链接、按钮、标题层级。
- `text` / `html` / `extract`：读取正文或指定 DOM。

## 什么时候使用

- 前端页面、登录页、报表、文档预览需要确认布局。
- 用户要求“看看页面现在是什么样”。
- 生成 HTML/PDF/PPT/DOCX 后，需要做视觉检查。
- 搜索页面抽取结果质量差，需要直接查看页面文本或截图。

## 推荐流程

1. 用 `start` 启动浏览器，`navigate` 打开目标 URL。
2. 用 `set_viewport` 分别检查桌面和移动端尺寸。
3. 用 `snapshot` 确认页面结构；需要视觉结果时用 `screenshot`。
4. 对前端任务，检查文字是否溢出、按钮是否重叠、主要内容是否在首屏可见。
5. 完成后可用 `stop` 关闭浏览器，避免长期占用资源。

## 需要未来扩展时

如果用户明确要求“可见浏览器窗口”“接管已经打开的 Chrome”“指定浏览器参数”，应说明当前工具未实现这些参数。可建议后续扩展 `browser_action` 的启动配置，但不要在当前任务中假装可用。
