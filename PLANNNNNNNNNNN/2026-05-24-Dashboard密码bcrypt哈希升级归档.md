# Dashboard 密码 bcrypt 哈希升级计划

日期：2026-05-24

## 背景

当前 Dashboard 密码（access 和 admin）以明文存储在 `data/dashboard-admin-pwd.txt` 和 `data/dashboard-access-pwd.txt` 中，登录时用 `safeCompare()` 做明文对比。如果文件泄漏（备份外传、路径穿越、服务器被入侵），密码直接可见。

## 目标

- 密码文件存储 bcrypt 哈希，不再存明文
- 无痛升级：现有用户不需要重新设置密码，首次登录自动迁移
- 保留紧急恢复能力：SSH 删文件重启即可重新生成

## 依赖

- `bcryptjs`（纯 JS 实现，无 native 编译，Windows/Linux 通用）
- 安装：`npm install bcryptjs`

## 改动范围

### 1. `packages/koishi-plugin-dashboard/lib/auth.js`

- 新增 `const bcrypt = require('bcryptjs')`
- 新增 `BCRYPT_ROUNDS = 12`
- 新增 `async function hashPassword(plain)` — 返回 bcrypt 哈希
- 新增 `async function verifyPassword(input, stored, upgradeFile)` — 核心验证函数：
  - `stored` 以 `$2a$` 或 `$2b$` 开头：走 `bcrypt.compare(input, stored)`
  - 否则当作旧明文：用 `safeCompare(input, stored)` 验证，通过后异步 `hashPassword(input)` 写回文件完成迁移
- 修改 `ensurePassword()`：生成随机密码后，存哈希到文件；明文只在日志打印一次
- 导出 `hashPassword`、`verifyPassword`

### 2. `packages/koishi-plugin-dashboard/lib/routes/auth.js`

- `handleLogin`：`safeCompare(password, stored)` → `await verifyPassword(password, stored, ACCESS_PWD_FILE)`
- `handleAdminVerify`：`safeCompare(password, getAdminPassword())` → `await verifyPassword(password, stored, ADMIN_PWD_FILE)`
- `handleChangePassword`：写入前 `const hash = await hashPassword(newPassword)`，写 hash 到文件
- `collectBody` 回调改成 async（或用 promise 包装）

### 3. `packages/koishi-plugin-dashboard/package.json`

- dependencies 新增 `"bcryptjs": "^2.4.3"`

## 兼容与降级策略

| 场景 | 行为 |
|------|------|
| 旧明文文件 + 正确密码登录 | 验证通过，后台自动升级为哈希 |
| 旧明文文件 + 错误密码 | 验证失败，不升级 |
| 已升级哈希文件 + 正确密码 | bcrypt.compare 通过 |
| SSH 手动写明文到文件 | 下次登录时自动升级为哈希 |
| SSH 删除密码文件 + 重启 | 自动生成新随机密码（哈希存储），明文打印到启动日志 |
| bcryptjs 包损坏/缺失 | 启动时 require 失败会报错，需要重新 npm install |

## 不改动的部分

- HMAC-SHA256 session token 机制不变
- 限流逻辑不变
- reset token 机制不变（仍然触发 `resetDashboardCredentials()`，只是内部改为存哈希）
- 前端不变（仍然 POST 明文密码到后端，由后端做哈希验证）
- 环境变量 `DASHBOARD_PASSWORD` / `DASHBOARD_ADMIN_PASSWORD` 仍支持，首次使用时存为哈希

## 验证方式

1. 不删旧密码文件，启动后用旧密码登录，确认登录成功且文件内容变成 `$2b$12$...`
2. 重启后再次登录，确认走 bcrypt 验证仍成功
3. 改密码后确认新密码文件也是哈希
4. 删除密码文件重启，确认日志打印新密码且文件存的是哈希
5. SSH 手动写明文 `test123` 到文件，用 `test123` 登录，确认成功且文件自动升级
6. 错误密码确认被拒绝，限流仍生效
