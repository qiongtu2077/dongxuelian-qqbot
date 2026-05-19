# 全部完成

## 本轮 commit 汇总

| Commit | 内容 |
|--------|------|
| ab9ed1e | feat: NSIS 安装包 + 自动更新 + npm install 后端改引导 |
| fe52282 | refactor: 前端 DeployPanel npm 步骤改引导模式 |
| fb0335b | fix: 删死代码 + 补 TTS API 导出修复构建 |
| ab276f7 | fix: P1 去除隐式代理修改、修 typo、修文案 |
| 99481d0 | fix: P2 加强 bat 依赖检测 + 删前端死分支 |
| 8281aca | chore: frontend/dist 加入版本控制 |
| 8199aa7 | fix: 修正 NSIS 配置属性名 createDesktopShortcut |

## 最新验证

- `npm run build:win` 成功生成 NSIS 安装包（莲莲Bot部署器 Setup 1.1.6.exe）
- 无代码签名（需付费证书），安装时会有 SmartScreen 警告
- 构建产物已清理（dist/ 已删除）

## 无待办
