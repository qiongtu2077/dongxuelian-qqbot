# 用户约束

## 核心规则
- **每次执行部署/推送前，必须先经过用户明确同意**，不得擅自操作
- 用户说「禁止」就是绝对禁止，必须先问

## 部署规则
- 禁止未经用户确认就执行部署、重启、git reset --hard
- 部署前确认服务器没有未保存的修改

## 推送规则
- 禁止推送 *.tgz / .claude/ / AUDIT-REPORT-*.md 到仓库
- 禁止未经用户确认就 git push

## Git 规则
- 不改动本地未提交的工作目录文件
- commit message 必须写详细清单（位置 + 原因 + 修复），不能只有标题
- 每个 commit 各显示各的作者，不混合署名

# AI 协作规则（源自 教训总结.md）

## 一、代码设计原则

- 非必要不往 index.js 加代码，新功能先判断是否适合独立模块
- 新模块只从 `constants.js` / `utils.js` / `api.js` / `conversation.js` / `persona.js` 等稳定模块导入
- **不反向 import `index.js`**，避免循环依赖
- 聊天核心链路（chat()）保留模型调用所有权，子模块通过回调与主流程交互

### 按边界拆，不按行数拆
- 补旧功能直接改原文件，长新功能器官才新模块
- 一个函数超 50 行且职责不单一就考虑拆分
- 行为变更优先加 scenario 测试，不加源码字符串扫描

### 拆文件 5 步法（必须遵守）
1. 只创建目标文件，完整复制函数+状态，`node -c` 确认语法
2. 源文件加 import，`node -c` 确认语法
3. 注释旧定义（不删），`npm run test:quick` 验证 import 生效
4. 测试通过后删旧代码，再跑 `npm run test:quick`
5. 更新 cascade-test.js 的引用路径，再跑测试

## 二、测试规则

### 测试入口职责
| 命令 | 职责 |
|------|------|
| `npm run check` | 生产 JS 语法检查 |
| `npm run test:quick` | 导出/常量/脚本/静态防线 |
| `npm run test:scenario` | fake Koishi 集成测试 |
| `npm test` | test:quick + test:scenario |

### 测试四问（任何测试报告必须回答）
1. 复现了用户哪条真实失败输入？
2. 断言了哪个失败现象不会再出现？
3. 哪些依赖被 mock 了？
4. 因为 mock，哪些真实链路仍未覆盖？

答不上就不能说"已验证修复"。

## 三、服务器部署

### 正确杀死进程
```bash
pkill -9 -f 'koishi'    # 不要用 pkill -f "start"（会杀 SSH）
sleep 4                  # 等端口释放
```

### 环境变量
- `DONGXUELIAN_AI_DATA_DIR` 必须显式设置，否则 data 会读到错误路径
- `DASHBOARD_HOST` 默认 127.0.0.1（本地），服务器需设为 0.0.0.0
- `DASHBOARD_PORT` 默认 5150
- 端口、路径、Shell 命令必须有环境变量覆盖，不裸硬编码

### 重启脚本
- 用 `/root/koishi-app/restart.sh`，不做手动 SSH 拼命令重启
- 部署后等 15 秒，确认日志有 `adapter connect to server`

### 首次部署大重构
- 不要只挑改动文件传，漏一个就崩。首次传整个 lib/ 目录

### DATA_DIR 分裂防护
- 运行时解析顺序：`DONGXUELIAN_AI_DATA_DIR` → `KOISHI_DIR/data` → `cwd()/data`
- 所有插件不能再用 `__dirname/../data` 作为默认运行时目录
- 所有启动入口必须显式设置 `KOISHI_DIR` 和 `DONGXUELIAN_AI_DATA_DIR`
- 服务器上包内 data 不能直接删：先备份，再非破坏合并，然后改成指向根 data 的软链接

### 进程管理
- `pkill -f` 再用 `sleep 3` 确保端口释放，防止双实例
- 多次尝试启动会产生孤儿进程抢占端口

## 四、依赖版本约束

### @satorijs/core 必须锁 3.7.0
- koishi 4.x + @satorijs/core 3.7.0 + adapter-onebot 6.x 是铁三角
- 升级 @satorijs/core 到 4.x → adapter-onebot 的 http.ws() 静默失败
- 每次 npm install 后验证：`node -e "console.log(require('@satorijs/core/package.json').version)"` 必须输出 3.7.0
- 改完重启后 grep `adapter connect to server` 确认连接
- 必须用本地 binary：`node node_modules/koishi/bin.js start`，不用全局 /usr/bin/koishi

## 五、插件开发规则

- 新插件复用主插件的 `runtime-config.js` + `api.js`，禁止自己写 API 客户端
- Koishi 中间件匹配到命令后，`await session.send()` + `return`，不能漏
- 日报等 Puppeteer 功能必须加信号量限制并发（最多 2 个）和超时（30 秒）
- 新增浏览器/抓取/流式逻辑时默认先按"会泄露"审视，补并发上限、总超时和低内存禁用
- 每个外部资源都要有自己的退出口：`browser.close()`、`page.close()`、`clearTimeout()`、`abortController.abort()` 放在 finally 里
- 动态模板用 `{{variable}}` 占位符，不用 `${variable}`
- SCP 同步用 `scp` 二进制传输，不用 PowerShell 管道（会转 UTF-16 损坏中文）
- 需要同步删除时用 `rsync -av --delete`，不用 `scp -r`
- `require('koishi')` 不导出 Session 类，必须从 `@satorijs/core` 获取

## 六、Dashboard 开发规则

- 敏感 API 请求头带 `X-Admin-Token`，密码存在独立文件不在代码硬编码
- AdminDialog visible 默认 false，API 返回 403 时才弹窗，z-index 高于所有覆盖层（10000）
- 所有触发异步操作的按钮：立即改变按钮文字 → 禁用 → 完成后滚动到结果区域 → 取消时清除 loading
- 新增模板变量后必须同步更新 setup() return 对象
- setup() return 超 15 个变量时应考虑迁移到 `<script setup>`
- 每次改 Vue 组件后必须在浏览器打开对应页面验证渲染（构建通过不代表运行正常）
- Dashboard 的 NapCat 代理通过 `127.0.0.1` 本地访问，不硬编码公网 IP

## 七、API 集成规则

- 调用第三方 API 前确认不同功能是否需要不同 model 参数
- API 集成时写明每个模型的输入约束
- 验证失败时优先检查请求参数格式是否匹配目标模型要求
- TTS 语音克隆必须用 `mimo-v2.5-tts-voiceclone` 模型（普通 TTS 用 `mimo-v2.5-tts`）
- 测试写操作的请求绝不要直接打到生产文件上

## 八、通用原则

- 做新功能前先判断：是已有类别的变体，还是真正的新类别？避免不必要的架构膨胀
- 新功能后必须同步更新帮助菜单
- 用户说「不要推」就是绝对不要推，想推也先问
- 覆盖前先确认服务器当前状态
- 修复前先确认原始代码在干净环境是否正常，不直接假设有 bug
