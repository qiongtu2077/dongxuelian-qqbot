# AI 协作规则

## 一、架构红线

1. **禁止重写或扩展 index.js 的中间件主业务逻辑。** 新增业务必须放独立模块；index.js 只允许做最小接线。确需改变主流程顺序时，必须先给方案并补 scenario。

2. **禁止循环依赖，尤其禁止 require('./index')。** 运行时配置从 runtime-config.js 引入；基础工具从 utils.js、constants.js 引入。

3. **禁止未经明确授权删除、放松、绕过 cascade-test.js 的防御性检查。** 新增模块、导出、语法检查和正负样例时，可以同步增强 cascade。

4. **测试默认不使用全局 fake timers。** 只有验证真实 setTimeout/setInterval 调度时，才允许显式 fakeTimers: true，并写明原因。

## 二、代码修改规范

1. **文件行数预警。** lib/ 下文件超过 350 行时须指出风险并建议拆分。已超标的 index.js / chat.js 不追溯；新增逻辑超过 50 行须先提拆分方案。

2. **函数复杂度。** 超过 50 行的函数须分析是否职责单一；不单一则优先拆 helper 或独立模块。

3. **新增模块同步。** 新增生产模块时，同步更新：
   - package.json scripts.check 加 node -c 检查
   - cascade-test.js 的 modPaths、syntaxFiles、duplicateScanFiles
   - 函数导出放 expectedExports；非函数导出单独写类型断言

4. **代码风格。** 新增或本轮修改的 lib 代码禁止新增 var，统一 const/let。旧 var 不追溯，触碰相关函数时顺手清理。

5. **命名风格。** 文件名沿用现有 kebab-case/既有命名；函数变量 camelCase；常量 UPPER_SNAKE_CASE。

6. **utils.js 边界。** utils.js 只保留纯工具函数，不混入业务逻辑。

7. **配置访问。** 运行时配置（provider/model/baseURL/apiKey/thinking）从 runtime-config.js 获取；静态常量、路径、正则、阈值可以从 constants.js 引入。

8. **新增模块注释。** 新增 lib/*.js 模块时，必须在文件头部添加 MODULE 注释块，至少包含：
   - 职责范围（一句话）
   - 边界约束（禁止做什么，如"不调 AI API""不改 conversation"）
   - 状态说明（如有 Map/Cache）

## 三、测试规范

1. **新增行为 = 新增测试。** 任何新增用户可感知行为必须新增或扩展 test/scenarios 场景测试。

2. **修改 handler 后提醒。** 修改 handler.js 命令路由后，提醒运行 npm run test:quick + npm run test:scenario。

3. **测试独立性。** 每个场景测试用独立 withScenario 调用，确保状态不污染。

4. **安全 ruleset。** 改安全 ruleset 时，cascade 至少补一个"应拦截"样例和一个"应放行"样例。
