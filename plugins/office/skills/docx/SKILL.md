---
name: docx
description: 使用 Lexora Office 创建、编辑和交付 Word DOCX，处理正文、标题、列表、表格、图表与修订；支持 Office 引用的精确写回和真实文件保存检查。
---

# DOCX

领域读取操作统一通过 `read({targetId,query:{operation:"操作名",input:"参数 JSON 对象字符串"}})` 调用，它们不是独立注册工具。解释、分析或检查任务止于读取和必要的渲染；新建、修改、管理或导出只在用户要求相应操作时进行。创建或修改文件任务以检查和产物交付收尾。

用 `lexora_tool_search` 搜索 Office。只阅读历史摘录先用宿主 `lexora_reference_list`，再按返回的 `sourceMessageId`、`kind`、`referenceId` 调用 `lexora_reference_read`；检查或修改当前引用对象走 `references → read(sourceMessageId,referenceId)`，由工具验证原文和定位后绑定目标；库文件走 `documents → read(documentId)`；新建用 `create(kind:"docx",name)`。取得 targetId/revision 后调用 `capabilities(targetId)` 获取真实操作 schema 与 操作目录。文稿由当前主 Agent 撰写，再交给确定性编辑工具。

读 `get_document_context` 了解文档块结构；长文用 `read_blocks` 分段读取，修订用 `read_revisions`。以返回的块索引/定位为准，插入或删除后重新读取，不沿用已变化的块索引。

按意图选择操作：新增用 insert_content，重写既有块用 replace_blocks，原引用的单段选区用 replace_text/replace_selection，段落和字符格式用 apply_ops。内容是受限 HTML，遵循 capability schema；不要把任意浏览器 HTML、脚本或外部文件操作混入文档。apply_ops 使用公布的 操作目录，不猜操作名。

`edit(targetId,expectedRevision,operation,input)` 的 input 为 JSON 对象字符串。每次使用最新 revision；自身编辑后继续 `read(targetId,query)`，原引用保留旧快照。只问解释时不修改。冲突时先检查最新文档 ID，不能转而写入同名文件或当前选区。

保存后重新读取标题、正文、表格和修订状态；最终 `export` 发布任务产物。当前 DOCX 工具不提供原生页面图片，不声称做过视觉排版验收；复杂版式要在编辑器中检查。创建或重排正文时读 [结构与格式](references/authoring.md)。
