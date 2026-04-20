# NapCat + Koishi 当前进度

更新时间：2026-04-20

## 总览

- 运行链路：`NapCat + Koishi + OneBot11`
- Koishi 版本：日志中已确认 `Koishi/4.18.11`
- QQ 机器人账号：`123456789`
- 当前已拆成两个独立功能：
  - 功能一：B 站视频解析 / 发送，部署脚本为 `vedio.md`
  - 功能二：群昵称 / 集合艾特，部署脚本为 `name.md`
- 新增使用说明文档：`语法.md`

## 功能一：B 站视频解析 / 发送

- 部署脚本：`vedio.md`
- 插件名：`local-video-sender`
- 状态：已完成，继续由独立视频插件负责
- 支持范围：
  - B 站标准视频链接
  - `BV` 号
  - `b23.tv` 短链接
  - QQ 小程序分享卡片
  - 包含 B 站链接的普通文本

## 功能二：群昵称 / 集合艾特

- 部署脚本：`name.md`
- 插件名：`group-name-at`
- 当前版本：`0.4.2`
- 服务器插件路径：`/root/koishi-app/node_modules/koishi-plugin-group-name-at/lib/index.js`
- 服务器数据文件：`/root/koishi-app/data/nickname-collections.json`
- 状态：本地脚本已更新完成，等待传到服务器并验证日志版本

### 已完成能力

- 每个群独立存储，不跨群共享。
- 所有人都可以添加昵称和维护集合。
- `@某人 昵称 猪`：给被 @ 的成员绑定昵称 `猪`。
- `at猪`：艾特 `猪` 下的全部成员，只返回纯艾特，不带括号说明。
- 同昵称绑定到第 2 个人时自动升级为集合。
- 只有从 1 人变 2 人时提示“已自动升级为集合”，第 3 人及以后不再提示。
- 存储以 `userId` 为准，显示名只作为缓存，群友改群昵称不会导致绑定错乱。
- 查看集合、艾特集合、查看成员时会尝试刷新群昵称。
- 批量添加自动去重。

### 已完成命令

```text
@某人 昵称 猪
at猪
删除昵称 猪
删除昵称 猪 @某人
查看集合 猪
查看昵称 猪
谁是 猪
查看全部集合
查看全部昵称
集合列表
nicklist
查看成员 创纪元
查看成员 @某人
@某人 昵称
创建集合 猪 @a @b @c
合并集合 A B
集合添加 猪 @a @b @c
集合删除 猪 @a @b
清空集合 猪
确认清空集合 猪
删除集合 猪
确认删除集合 猪
重命名集合 猪 佩奇
重命名昵称 猪 佩奇
复制集合 猪 狗
集合交集 A B
集合并集 A B
集合差集 A B
```

### 防误操作

- `删除集合 猪` 不会立即删除，会提示 60 秒内发送 `确认删除集合 猪`。
- `清空集合 猪` 不会立即清空，会提示 60 秒内发送 `确认清空集合 猪`。
- 直接发送确认命令但没有前置请求时，不会执行危险操作。

## 服务器部署步骤

不要复制旧选区，建议直接传整个本地文件：

```powershell
scp C:\Users\yun\Desktop\text\name.md root@你的服务器IP:/root/name.md
```

服务器执行：

```bash
bash /root/name.md
grep -n "PLUGIN_VERSION" /root/koishi-app/node_modules/koishi-plugin-group-name-at/lib/index.js
journalctl -u koishi -n 120 --no-pager | grep group-name-at
```

期望结果：

```text
const PLUGIN_VERSION = '0.4.2'
group-name-at 0.4.2 loaded
```

## 提交前检查

- `name.md`：群昵称 / 集合艾特插件部署脚本，版本 `0.4.2`
- `vedio.md`：B 站视频功能部署脚本
- `语法.md`：Bot 所有调用语法
- `napcat-koishi-status.md`：当前进度与部署说明

建议不要提交临时检查文件，例如 `name-plugin-check.js`。
