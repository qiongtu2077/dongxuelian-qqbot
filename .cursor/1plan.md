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

## 改动总结

1. 部署器从 portable EXE 切换为 NSIS 安装包（桌面快捷方式+开始菜单+可卸载）
2. 新增 electron-updater 自动更新（GitHub Releases）
3. npm install 改为用户手动引导模式（前后端都已适配）
4. 一键部署链路审查并修复全部 P0/P1/P2 问题
5. frontend/dist 加入 git，pull 后自动更新界面

## 无待办
