# 2026-05-20 Phase 4 Dashboard 安全修复归档

> 来源：`AUDIT-REPORT-SUPPLEMENT-2026-05-19.md`
> 执行分支：`bot_ZZY`
> 归档范围：本轮已经完成的 Phase 4 Dashboard/Server 修复项

本文只归档已经完成的修复。用户明确要求暂不处理的“架构改进建议”不纳入本归档；审计报告里的延后项继续保留为延后项。

## 完成概览

本轮完成了 Phase 4 中除架构建议外的所有可执行项：

| 编号 | 风险点 | 处理结果 |
| --- | --- | --- |
| N4 | 登录密码直接用 `===` 比较 | 已改为 `safeCompare(password, stored)` |
| N5 | 重置 token 直接用 `!==` 比较 | 已改为 trim 后使用 `safeCompare(inputToken, storedToken)` |
| S13 | `httpsGetJson` 可无限重定向 | 已加入 `MAX_REDIRECTS`，默认 5 次 |
| S14 | `downloadToRuntime` 可无限重定向 | 已复用 `MAX_REDIRECTS`，默认 5 次 |
| S15 | NapCat token 通过 URL query 传递 | 已改为 HTTP header，不再拼接 `webui_token` |
| N11 | Dashboard server 缺少 CSP | 已添加 `Content-Security-Policy` 和 `X-Content-Type-Options: nosniff` |
| N12 | GitHub JSON 响应体无大小限制 | 已加入 `MAX_JSON_RESPONSE_BYTES`，默认 10MB，超限销毁请求 |
| N13 | 下载失败/超限后临时文件残留 | 已在错误路径统一清理 partial 文件 |
| N16 | `query_logs` 直接使用用户输入构造正则 | 已加入复杂度检测，危险正则退化为字面量搜索 |
| N18 | deploy task ID 使用 `Math.random` | 已改为 `crypto.randomBytes(4).toString('hex')` |

附带修复：

| 项目 | 处理结果 |
| --- | --- |
| `npm run check` 中 Electron deployer ESM 语法检查 | 原先 `node -c` 会误判 ESM `export`，已改为 `node --check --input-type=module < ...` |
| cascade 静态/回归守卫 | 已补充本轮安全项的防回退断言 |

## 修改文件

| 文件 | 主要变化 |
| --- | --- |
| `packages/koishi-plugin-dashboard/lib/routes/auth.js` | 登录密码、管理员密码、重置 token 校验改为 `safeCompare` |
| `packages/koishi-plugin-dashboard/standalone.js` | 添加 CSP/nosniff；NapCat WebUI 代理不再拼接 token query |
| `packages/koishi-plugin-dashboard/lib/napcat-proxy.js` | token 改从 header 传递；过滤外部传入的敏感 header |
| `packages/koishi-plugin-dashboard/lib/deploy-helpers.js` | 下载/API 请求增加重定向上限、JSON 响应体上限、失败清理 partial 文件 |
| `packages/koishi-plugin-dashboard/lib/routes/deploy.js` | deploy task ID 改用 crypto 随机字节 |
| `packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/query-logs.js` | 增加危险正则检测与字面量 fallback |
| `packages/koishi-plugin-dongxuelian-ai/test/cascade-test.js` | 增加本轮安全修复的静态/回归守卫 |
| `package.json` | 修正 Electron deployer 的 ESM 语法检查命令 |

## 关键实现记录

### N4 / N5：认证比较时序安全

- 登录密码由直接字符串比较改为 `safeCompare(password, stored)`。
- 重置 token 先分别 `trim()`，再使用 `safeCompare(inputToken, storedToken)`。
- 管理员密码验证与旧密码修改校验也同步使用 `safeCompare`，避免同类问题残留。

### S13 / S14：重定向上限

- 新增 `MAX_REDIRECTS`，默认值 5。
- 可通过 `DASHBOARD_MAX_REDIRECTS` 覆盖，范围限制为 0 到 20。
- `httpsGetJson` 和 `downloadToRuntime` 都记录当前重定向次数，超过上限后返回错误。

### S15：NapCat token 不走 URL query

- `/webui` 代理调用不再构造 `webui_token=...`。
- 代理请求中添加：
  - `Authorization: Bearer <token>`
  - `webui-token: <token>`
- 转发前删除外部请求带入的敏感头：
  - `authorization`
  - `x-napcat-token`
  - `x-admin-token`

### N11：Dashboard CSP

Dashboard server 统一添加 CSP，当前策略包含：

- `default-src 'self'`
- `script-src 'self' 'unsafe-inline'`
- `style-src 'self' 'unsafe-inline'`
- `img-src 'self' data: blob:`
- `font-src 'self' data:`
- `connect-src 'self' ws: wss:`
- `frame-src 'self'`
- `object-src 'none'`
- `base-uri 'self'`
- `frame-ancestors 'self'`

同时添加 `X-Content-Type-Options: nosniff`。

### N12：JSON 响应体上限

- 新增 `MAX_JSON_RESPONSE_BYTES`，默认 10MB。
- 可通过 `DASHBOARD_MAX_JSON_RESPONSE_BYTES` 覆盖，范围限制为 1KB 到 64MB。
- `httpsGetJson` 累积 body 时检查 `Buffer.byteLength(body, 'utf8')`，超限后结束并销毁请求。

### N13：partial 文件清理

- `downloadToRuntime` 增加统一 `finish()` 收口。
- 下载超限、校验失败、请求错误等错误路径会调用 `cleanupPartial(filePath)`。
- 避免失败下载残留临时文件。

### N16：`query_logs` ReDoS 防护

- 增加 `isUnsafeRegexQuery()` 检查常见高风险嵌套量词模式。
- 危险 query 不再作为正则语义执行，改为 `escapeRegExp(query)` 后做字面量搜索。
- cascade 增加 `(a+)+` 字面量查询回归，防止未来回退成直接正则执行。

### N18：deploy task ID 随机性

- task ID 保留时间前缀，随机后缀改为 `crypto.randomBytes(4).toString('hex')`。
- 不再依赖 `Math.random().toString(36).slice(...)`。

## 验证记录

已执行：

```bash
npm run check
npm test
git diff --check
node -e "console.log(require('@satorijs/core/package.json').version)"
```

结果：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 通过 |
| `git diff --check` | 通过；仅有既有前端文件 LF/CRLF 工作区换行提示 |
| `@satorijs/core` 版本检查 | 输出 `3.7.0` |

`npm test` 明细：

| 测试入口 | 结果 |
| --- | --- |
| `npm run test:quick` | 通过；此前单跑结果为 `passed: 1487, failed: 0, skipped: 1` |
| `npm run test:scenario` | 通过；`passed: 501, failed: 0, skipped: 2` |
| `npm run test:plugins` | 通过 |

备注：

- scenario 中 `setup.sh` 相关用例在当前 Windows/无 bash 环境下跳过，属于环境 skip。
- 测试结束时出现过 `MaxListenersExceededWarning`，但测试进程退出码为 0，未导致失败。

## 测试四问

1. 复现了用户哪条真实失败输入？

   本轮主要处理审计报告中的安全与健壮性问题，不是某条聊天用户输入导致的功能失败。新增回归里使用 `(a+)+` 作为危险日志查询输入，覆盖 `query_logs` 的 ReDoS 风险入口。

2. 断言了哪个失败现象不会再出现？

   - 密码/token 不再使用直接字符串比较。
   - NapCat token 不再通过 URL query 暴露。
   - GitHub API JSON 读取不会无限累积响应体。
   - API/下载链路不会无限重定向。
   - 下载失败或超限后不会留下 partial 文件。
   - deploy task ID 不再使用 `Math.random`。
   - 危险日志查询正则不会按正则语义执行，而会退化为字面量搜索。

3. 哪些依赖被 mock 了？

   本轮新增的 cascade 守卫主要是静态源码断言和本地临时日志文件回归。完整 `npm test` 中既有 scenario 会 mock Koishi session、HTTP/API、部分插件运行环境与模型响应。

4. 因为 mock，哪些真实链路仍未覆盖？

   未真实连接 NapCat WebUI、GitHub 远端大响应/重定向链、生产部署服务器，也未在真实浏览器中验证 CSP 对所有页面资源的影响。这些属于后续部署前或服务器环境 smoke test 范围；部署、重启、推送均需用户明确确认。

## 未执行事项

- 未执行部署。
- 未执行服务器重启。
- 修复与验证阶段未执行 `git push`；本次按用户明确要求提交并推送。
- 未执行 `git reset --hard`。
- 未处理“架构改进建议”。
- 未处理审计报告中的延后项。
