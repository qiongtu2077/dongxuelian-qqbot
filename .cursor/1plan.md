# 当前状态：P0 + P1 + P2 全部完成

## 本轮全部 commit

| Commit | 内容 |
|--------|------|
| ab9ed1e | feat: NSIS 安装包 + 自动更新 + npm install 后端改引导 |
| fe52282 | refactor: 前端 DeployPanel npm 步骤改引导模式 |
| fb0335b | fix: 删死代码 + 补 TTS API 导出修复构建 |
| ab276f7 | fix: P1 去除隐式代理修改、修 typo、修文案 |
| 99481d0 | fix: P2 加强 bat 依赖检测 + 删前端死分支 |

## 待决定

问题 3：frontend/dist 是否加入 git？
- 方案 A：加入 git → pull 后自动有新界面
- 方案 B：不加 → 保持现状，部署时手动重建
- 当前状态：不在 git 中，需远程重建

## 备注

- 分支 YUN，最新 99481d0
- 测试全绿
- frontend/dist 本地已重建（但 gitignore 排除）
