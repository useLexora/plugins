---
name: pptx
description: 使用 Lexora Office 创建、编辑和交付 PowerPoint PPTX，处理幻灯片内容、元素布局和样式，通过原子操作、布局检查及实际页面渲染验证演示文稿。
---

# PPTX

领域读取操作统一通过 `read({targetId,query:{operation:"操作名",input:"参数 JSON 对象字符串"}})` 调用，它们不是独立注册工具。解释、分析或检查任务止于读取和必要的渲染；新建、修改、管理或导出只在用户要求相应操作时进行。创建或修改文件任务以检查和产物交付收尾。

用 `lexora_tool_search` 搜索 Office。只阅读历史摘录先用宿主 `lexora_reference_list`，再按返回的 `sourceMessageId`、`kind`、`referenceId` 调用 `lexora_reference_read`；检查或修改当前引用对象走 `references → read(sourceMessageId,referenceId)`，由工具验证原文和定位后绑定目标；库文件走 `documents → read(documentId)`；新建用 `create(kind:"pptx",name)`。取得 targetId/revision 后调用 `capabilities(targetId)` 获取实际 apply_ops schema、操作词表和渲染能力。提纲、文字和布局由当前主 Agent 规划，不启动 GenOffice 内部生成 Agent。

先 get_presentation_context 看画布和页结构，再 read_slide 看元素 ID、类型、位置和文字。针对返回的明确页和元素操作，不靠当前选中页。需要操作细节时用 load_guide 按任务读取；修改前可用 apply_ops dryRun 检查，再以最新 expectedRevision 提交。

`edit` 的 input 是 JSON 对象字符串。apply_ops 为 1–50 个受支持操作的原子事务；沿用实际元素 ID 和单位，不猜测能力。原引用的独立文本框可用 replace_text。新增或删除后重新读结构，自己的修改继续 `read(targetId,query)`，原引用仍保留旧文字。

保存后 check_layout 检查布局，再 `render(targetId,input:'{"slideIndexes":[0]}')` 看实际幻灯片。单次最多 4 页，索引从 0 开始；检查标题层级、溢出、遮挡、对齐和文字密度。修正并复查后 `export` 发布任务产物。

创作和单位细节见 [布局与创作](references/layout.md)。
