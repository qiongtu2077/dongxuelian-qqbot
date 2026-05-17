---
name: QA_source_index
kind: docs
description: 莲莲Bot 源码与文档索引。用于回答“去哪里查”“某功能在哪改”“测试该跑什么”的代码库问题，减少盲目全库搜索。
---

# QA Source Index

当用户问到莲莲Bot的实现、配置、部署、测试或前端入口时，先用本索引定位候选文件，再根据可用工具读取实际源码。不要只凭索引给结论。

## Agent 与工具

- Agent 主循环：`packages/koishi-plugin-dongxuelian-ai/lib/agent/engine.js`
- Agent 消息构建：`packages/koishi-plugin-dongxuelian-ai/lib/agent/messages.js`
- Agent 工具注册：`packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/registry.js`
- 工具开关与默认权限：`packages/koishi-plugin-dongxuelian-ai/lib/agent/config.js`
- 危险工具审批：`packages/koishi-plugin-dongxuelian-ai/lib/agent/safety.js`、`packages/koishi-plugin-dongxuelian-ai/lib/agent/pending.js`
- 路径边界：`packages/koishi-plugin-dongxuelian-ai/lib/agent/path-guard.js`

## Skill 与人格

- 实用 Skill 索引和按需读取：`packages/koishi-plugin-dongxuelian-ai/lib/agent/skills.js`
- Skill 开关命令：`packages/koishi-plugin-dongxuelian-ai/lib/agent/skill-hub.js`
- Agent 人格上下文：`packages/koishi-plugin-dongxuelian-ai/lib/agent/persona-context.js`
- 普通聊天人格管理：`packages/koishi-plugin-dongxuelian-ai/lib/persona.js`
- 人格文件目录：`packages/koishi-plugin-dongxuelian-ai/data/ai-skills/personas/`
- 核心安全规则目录：`packages/koishi-plugin-dongxuelian-ai/data/ai-skills/core/`

## 搜索与浏览器

- 搜索查询规划与结果打分：`packages/koishi-plugin-dongxuelian-ai/lib/agent/search-query.js`
- web_search 工具：`packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/web-search.js`
- 浏览器工具：`packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/browser-action.js`
- QQ 显式搜索路由：`packages/koishi-plugin-dongxuelian-ai/lib/agent/router.js`

## QQ 命令和聊天链路

- Koishi 插件入口：`packages/koishi-plugin-dongxuelian-ai/lib/index.js`
- 命令路由：`packages/koishi-plugin-dongxuelian-ai/lib/handler.js`
- 普通聊天：`packages/koishi-plugin-dongxuelian-ai/lib/chat.js`
- API 调用与 fallback：`packages/koishi-plugin-dongxuelian-ai/lib/api.js`
- 对话、记忆与摘要：`packages/koishi-plugin-dongxuelian-ai/lib/conversation.js`
- 防越狱规则：`packages/koishi-plugin-dongxuelian-ai/lib/rulesets/jailbreak.js`

## 前端与 Dashboard

- 独立 Agent Console：`packages/agent-console/src/main.tsx`
- Agent Console API 客户端：`packages/agent-console/src/api/client.ts`
- Agent Console 样式：`packages/agent-console/src/styles.css`
- Dashboard standalone 后端：`packages/koishi-plugin-dashboard/standalone.js`
- Dashboard Agent 面板：`packages/koishi-plugin-dashboard/frontend/src/components/AgentPanel.vue`

## 测试与质量门禁

- 结构测试：`packages/koishi-plugin-dongxuelian-ai/test/cascade-test.js`
- 场景测试入口：`packages/koishi-plugin-dongxuelian-ai/test/scenario-test.js`
- 聊天场景：`packages/koishi-plugin-dongxuelian-ai/test/scenarios/chat.test.js`
- 命令场景：`packages/koishi-plugin-dongxuelian-ai/test/scenarios/command.test.js`
- fake 数据目录：`packages/koishi-plugin-dongxuelian-ai/test/fake/file.js`
- 根检查命令：`package.json` 的 `scripts.check`

新增生产 JS 模块时，必须同步 `package.json` 的 `check` 脚本、`cascade-test.js` 的模块路径、导出、语法检查和重复函数扫描列表。

## 部署

- AI 包部署：`scripts/ai.sh`
- 通用包部署：`scripts/deploy-package.sh`
- 重启脚本：`scripts/restart-bot.sh`
- 初始化脚本：`setup.sh`

部署时不要覆盖服务器私有配置和运行数据。`ai-skills` 会跟随 AI 包复制，但核心/persona 等目录中的已有用户内容需要谨慎处理。
