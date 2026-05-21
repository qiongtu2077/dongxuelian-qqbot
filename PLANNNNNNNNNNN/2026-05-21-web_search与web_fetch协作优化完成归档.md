# 2026-05-21 web_search 与 web_fetch 协作优化完成归档

> 来源：`待完成与待审核任务/web_search与web_fetch协作优化计划.md`
> 归档时间：2026-05-21
> 状态：已完成并从待办目录移除

## 归档结论

本轮已把 `web_fetch` 从独立读 URL 工具升级为 `web_search` 的候选正文读取协作层：共享 `readCandidatePage()`，统一正文质量判断，`web_search` 输出明确区分“搜索页摘要”和“已打开候选网页正文”，并补充 prompt 与 quick/scenario 回归测试。

---

# 原计划记录

创建时间：2026-05-21

## 一、目标

把 `web_fetch` 从“独立但很少直接用的读 URL 工具”，升级为 `web_search` 的稳定协作层：

```text
web_search：理解用户语义，生成 query，搜索候选来源，排序与判断可信度
web_fetch：读取 web_search 选出的候选链接正文，或读取用户明确给出的 URL
browser_action：只做 JS 渲染、点击、截图等重型兜底
```

最终体验：

- 用户不知道 URL，只问“查一下/搜一下/最新”：走 `web_search -> 候选链接 -> web_fetch 正文`。
- 用户给了 URL 并要求总结：走 `web_fetch`。
- 页面正文太短、需要 JS 或交互：明确提示，并按配置兜底 `browser_action`。

## 二、当前已完成

- `web_fetch` 工具已存在，支持公开 HTTP/HTTPS URL 读取。
- 已有共享 `agent/fetch-reader.js`，包含协议限制、DNS 私网校验、手动 redirect、大小限制、超时、标题/类型提取。
- `web_search` 的 HTTP 兜底已经会搜索候选、排序，并读取靠前候选网页正文。
- `web_fetch` 和 `web_search` 候选正文读取已共享底层 reader。
- `web_fetch` 默认不对 QQ / Dashboard 开放，避免普通聊天随手贴 URL 就被抓取。
- 浏览器搜索默认不启用，只作为显式配置下的重型兜底。

## 三、存在问题

1. `web_fetch` 的产品定位还不够清楚。
   它现在像一个单独工具，但真正价值是作为 `web_search` 搜到链接后的正文读取层。

2. `web_search` 内部虽然已经 fetch 候选正文，但工具结果格式还不够“证据化”。
   模型有时难判断哪些只是搜索页摘要，哪些是打开正文后的来源。

3. `web_fetch` 和 `http-search` 的正文清洗、短正文判断、结构化返回还可以再统一。
   目前能用，但还没形成清晰的“候选正文读取结果对象”。

4. 普通聊天入口仍偏保守。
   目前更适合通过 `莲莲 agent 搜一下 xxx` 使用；后续若开放普通聊天，需要只对显式联网语义触发。

## 四、推荐实现顺序

### Phase 1：统一“候选正文读取”接口

新增或整理一个内部函数，例如：

```text
readCandidatePage(url, options)
```

返回结构化结果：

```text
{
  ok,
  url,
  finalUrl,
  title,
  status,
  contentType,
  text,
  textQuality,
  reason,
  truncated
}
```

要求：

- `web_fetch` 调它。
- `http-search` 的候选正文读取也调它。
- 保留 SSRF、redirect、大小、超时防线。

### Phase 2：让 `web_search` 明确输出“候选 + 正文证据”

`web_search` 结果里区分三类信息：

- 搜索页摘要：只能低确信参考。
- 已打开正文：可作为主要依据。
- 打开失败原因：短正文、超时、JS 渲染、SSRF 拦截等。

回答提示里要求模型：

- 优先依据“已打开正文”。
- 只有搜索摘要时降低确信度。
- 来源冲突时说明冲突，不合并编造。

### Phase 3：把 `web_fetch` 定位为 `web_search` 的读页工具

更新工具描述和 Agent prompt：

- 不知道 URL：先 `web_search`。
- 搜到候选后：由搜索链路读取正文，必要时再调用 `web_fetch` 展开某个候选 URL。
- 用户直接给 URL：用 `web_fetch`。

避免让模型把“搜索问题”错误交给 `web_fetch` 导致 `url 不能为空`。

### Phase 4：保守开放入口

先开放明确表达：

```text
莲莲 agent 搜一下 xxx
莲莲 agent 查一下 xxx
莲莲 agent 总结这个链接 https://...
```

后续再考虑普通聊天：

```text
东雪莲查一下 xxx
东雪莲联网查 xxx
```

不做“看到任意 URL 自动抓取”。

## 五、测试重点

- 没有 URL 的问题必须走 `web_search`，不能走 `web_fetch` 空 URL。
- 有明确 URL 且用户要求总结时，走 `web_fetch`。
- `web_search` 命中候选后，至少能区分“已打开正文”和“仅搜索摘要”。
- 候选正文短、JS 页面、超时、私网 redirect 都不能让模型编造。
- `web_fetch` 默认开关保持关闭，除非用户明确决定开放。
- `browser_action` 仍只作为显式配置兜底，不因本优化默认启动。

## 六、验收标准

- `npm run check` 通过。
- `npm run test:quick` 通过。
- 相关 scenario 覆盖 search -> fetch 证据链。
- 手工验证：
  - 搜索未知信息能返回来源。
  - 总结明确 URL 能返回正文摘要。
  - 短正文页面不会编造。

## 七、暂不做

- 不把 `web_fetch` 当成完整搜索工具。
- 不让 QQ 默认开启所有外部网页读取。
- 不默认启用浏览器搜索。
- 不处理需要登录的网站。
