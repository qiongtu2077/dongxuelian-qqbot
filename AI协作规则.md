# AI 协作规则

## 一、架构红线

1. **禁止重写或扩展 index.js 的中间件主业务逻辑。** 新增业务必须放独立模块；index.js 只允许做最小接线。确需改变主流程顺序时，必须先给方案并补 scenario。

2. **禁止循环依赖，尤其禁止 require('./index')。** 运行时配置从 runtime-config.js 引入；基础工具从 utils.js、constants.js 引入。

3. **禁止未经明确授权删除、放松、绕过 cascade-test.js 的防御性检查。** 新增模块、导出、语法检查和正负样例时，可以同步增强 cascade。

4. **测试默认不使用全局 fake timers。** 只有验证真实 setTimeout/setInterval 调度时，才允许显式 fakeTimers: true，并写明原因。

## 二、代码修改规范

0. **新增正则必须避免 ReDoS：**
   - 禁止嵌套量词（如 `(a+)+`、`(\w*\d*)+`）
   - `.*` 和 `.+` 必须配合尾部字面量锚定，或替换为 `.{0,N}` 有界版本
   - 用户输入正则优先用字面量串联，少用长 alternation

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

## 四、AI 行为准则

1. **先摸底再动刀。** 改代码前先读：`rg` 搜入口/调用点/常量/测试覆盖，看现有风格，看 `package.json` scripts，看 dirty worktree。能从仓库确认的事实不靠猜。

2. **小施工面。** 按依赖顺序改：底层常量/配置 → 调用点 → 测试/fake/setup → cascade/文档。每步保持行为一致，不把无关重构混进来。

3. **最小 diff。** 最小替换调用点，不重排大段逻辑，不顺手格式化整个文件，不改编码，不改中文文案，不碰无关文件。

4. **行为测试优先。** 用户可见行为变更优先加 scenario；cascade 只守结构契约、导出、防线和架构红线，不用源码字符串扫描替代行为测试。

5. **不靠猜定位。** 测试挂了先分清楚是语法、导出、行为、环境 skip、断言脆弱，还是暴露真实旧 bug。阻塞当前任务或同改动面的明确小 bug 可以最小修复；无关大问题不顺手展开。

6. **验证闭环。** 相关文件先跑 `node -c`；常规收尾跑 `npm run check`、按范围跑 `npm run test:quick` / `npm run test:scenario` / `npm run test:plugins`，最后跑 `npm test` 和 `git diff --check`。环境限制导致 skip 要说明清楚。

7. **不越界。** 不做破坏性 git 操作，不回滚已有改动，不加 `_testOnly`，不引入新框架/新依赖/新数据库，不把小需求扩成大重构。

8. **部署守则。** 正式部署优先使用已有部署脚本；手工 SSH/SCP 修复时分批输送：传一个文件 → 确认 → 下一个。不一次覆盖整包，不覆盖服务器配置文件和 data 文件。

9. **新状态新 IO 就拆模块。** 小于 50 行但引入新 `Map`、文件 IO、定时器、协议、缓存所有权，优先独立模块。超过 80 行的新功能必须先提拆分方案。

10. **遇到未知先收窄，不扩大战场。** 测试或阅读代码时暴露问题，先分类再处理：
    - 阻塞当前任务的真实 bug：允许做最小修复，并在总结里说明。
    - 与当前改动同一调用链、同一文件或同一行为面，且修复很小、测试能覆盖的小 bug：允许顺手修。
    - 无关历史问题、需要产品取舍、会牵出大范围重构或迁移的问题：不顺手修，只记录、说明，必要时另开计划。
