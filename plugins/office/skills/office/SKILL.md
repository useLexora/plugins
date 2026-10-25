---
name: office
description: 管理 Office 文档库、新建或交付 DOCX/XLSX/PPTX/PDF 文件，处理引用写回、版本恢复及跨格式文档任务。具体排版、表格和页面操作使用对应格式技能。
---

# Office 套件

领域读取操作统一通过 `read({targetId,query:{operation:"操作名",input:"参数 JSON 对象字符串"}})` 调用，它们不是独立注册工具。解释、分析或检查任务止于读取和必要的渲染；新建、修改、管理或导出只在用户要求相应操作时进行。创建或修改文件任务以检查和产物交付收尾。

这是同一个 Lexora Office 插件中的公共工作流；所有内容规划和工具调用由当前 Lexora 主 Agent 完成。使用 `lexora_tool_search` 搜索 Office 工具，然后调用“查询 Office 能力”。工具实际返回的操作、参数 schema 和限制是执行依据。

按输入选择入口：

- 历史引用的解释、总结、对照：先用宿主 `lexora_reference_list` 获取引用身份，再以返回的 `sourceMessageId`、`kind`、`referenceId` 调用 `lexora_reference_read`，用 `offset`/`limit` 分页读取引用时保存的正文，不需要打开或保存当前文档。
- 检查或修改引用对应的当前内容：`references → read(sourceMessageId,referenceId)`。Office 验证当前结构定位和准确原文，成功后建立新的 target。其它位置保存不直接使引用失效；目标原文变化、定位不唯一或无法验证时拒绝重绑，不把旧快照当作当前内容。独立页面复制的引用粘贴进任务后也走这条链。
- 已在文档库：`documents → read(documentId)`。名称可能重复，结合 ID、修改时间和用户意图选择。
- 新建：`create(kind,name)` 返回 `targetId/revision`，再读取对应格式能力并写入内容。
- 本机文件或任务附件尚未入库：使用宿主现有“用 Office 打开”或文档库导入入口；不要用原路径覆盖插件私有文件。相同来源打开会复用原库记录，用户明确要求另存时才 duplicate。

调用 `capabilities(targetId)` 后，按任务读取 `docx`、`xlsx`、`pptx` 或 `pdf` 技能。每个技能也能独立完成格式内的创建、修改和交付，不必反复加载全部技能。

`references` 返回每条引用的 `sourceMessageId/referenceId`，必须配对使用，不能只按引用 ID 选择最新消息。`read` 返回当前内容（`contentState=current`）、文档版本、操作目标和 revision；`edit` 使用同一 `targetId` 及最新 `expectedRevision`，`input` 为对应操作 schema 的 JSON 对象字符串。自己的修改后继续 `read(targetId,query)`，原引用不会因此更新。需要指定新位置时用格式查询参数，不依赖当前鼠标选区。用户手改、其他页面修改、关闭会话或租约到期后，旧目标会拒绝；新轮次、排队执行与子 Agent 必须分别重新读取，不能沿用其他执行的 targetId；检查最新文档 ID 后重新打开，不重放旧请求。

保存后检查真实内容和结构；对版式敏感的交付，在格式支持时用 `render` 看图核对，再 `export(targetId,expectedRevision)`。`saved=true` 只代表文档库已保存；`export` 发布当前任务的产物卡片，才是文件交付。不要声称覆盖了导入来源，也不要伪造产物路径或链接。

管理和失败恢复时读 [文档生命周期](references/lifecycle.md)。
