# 主控制台 Jest + Cypress 测试

本目录只测试主控制台，不测试跳转后的独立 Agent 控制台。

- `npm run test:unit`：纯逻辑和静态契约测试。
- `npm run test:component`：Vue 组件测试。
- `npm run test:integration`：前端请求与后端返回契约测试。
- `npm run test:e2e`：启动主控制台 Vite 服务并运行 Cypress 浏览器测试。

测试不得连接生产服务器，也不得写生产数据。远端服务器核对由独立的只读 SSH 检查完成。
