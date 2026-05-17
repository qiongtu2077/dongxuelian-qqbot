---
name: pptx-generator
kind: docs
description: 根据结构化 slides JSON 生成 PPTX 文件，并通过 send_file_to_user 发送。
tags:
  - docs
  - pptx
---

# PPTX 生成 Skill

适用场景：用户明确要求生成 PPT / PPTX / 演示文稿。

## 工作流

1. 先把内容整理成 slides JSON，每页包含 `title`、`bullets`、`notes`。
2. 使用 `execute_javascript` 或受控 shell/node 脚本运行 `data/ai-skills/docs/pptx/generate-pptx.js`。
3. 输出文件必须写入 `data/agent-docs/` 或允许的工作目录。
4. 生成完成后用 `send_file_to_user` 发送文件；发送失败时回复本地文件路径。

## slides JSON 示例

```json
{
  "title": "版本更新说明",
  "slides": [
    { "title": "概览", "bullets": ["新增角色", "玩法优化", "活动日程"] },
    { "title": "新增内容", "bullets": ["角色 A", "武器 B"], "notes": "数据来自官方公告" }
  ]
}
```

## 约束

- 不要把 API Key、cookie、私密群聊原文写进 PPT。
- 幻灯片标题控制在 40 字以内，每页 bullet 不超过 7 条。
- 如果环境缺少 `pptxgenjs`，先说明需要安装依赖，不要伪造已生成文件。
