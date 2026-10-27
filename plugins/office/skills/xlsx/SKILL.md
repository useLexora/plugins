---
name: xlsx
description: 使用 Lexora Office 创建、分析、修改和交付 XLSX，处理数据类型、显式公式、单元格格式、工作表及行列结构；验证保存后的内容、公式和保真限制。
---

# XLSX

领域读取操作统一通过 `read({targetId,query:{operation:"操作名",input:"参数 JSON 对象字符串"}})` 调用，它们不是独立注册工具。解释、分析或检查任务止于读取和必要的渲染；新建、修改、管理或导出只在用户要求相应操作时进行。创建或修改文件任务以检查和产物交付收尾。

用 `lexora_tool_search` 搜索 Office。只阅读历史摘录先用宿主 `lexora_reference_list`，再按返回的 `sourceMessageId`、`kind`、`referenceId` 调用 `lexora_reference_read`；检查或修改当前引用对象走 `references → read(sourceMessageId,referenceId)`，由工具验证原文和定位后绑定目标；库文件走 `documents → read(documentId)`；新建用 `create(kind:"xlsx",name)`。取得 targetId/revision 后调用 `capabilities(targetId)`，读取真实 schema 和限制。这是 Office 套件的表格技能，已有库文件通过实时工具修改，不用文件脚本覆盖插件私有工作副本。

先用 get_workbook_context 查 sheetId、名称、维度、保护状态，再用 read_range/read_formats 检查目标范围。数据查找用 find_cells，聚合用 aggregate_range，保存检查用 check_workbook。A1 范围与 sheetId 显式传入，不能凭活动工作表、截图或同名文件决定修改位置。

写值或公式用 set_cells；格式用 format_range；同一表的值/格式批次用 batch，可先 dryRun。工作表、行列、冻结、合并和排序仅使用 capabilities 公布的操作。input 是 JSON 对象字符串，写入使用当前 targetId 和最新 expectedRevision。

自己的修改后继续 `read(targetId,query)`，不是重新解析旧引用。用户手改造成冲突时，检查文档并重新打开明确 documentId。saved=false 表示尚未写盘；有 saveError 才代表保存失败。按用户要求补保存，不重复已经应用的修改。

公式必须显式写作 `{formula:"=SUM(B2:B5)"}`；普通以 `=` 开头的字符串仍是文本。插件目前不重算公式，缓存值可能旧或为空，不能宣称已验证计算结果。图表/透视表等未开放写操作的对象保持原件，不擅自重建。

按 [数据、格式与验收](references/workflow.md) 检查实际内容后 `export` 发布任务产物。本地文件保存写回绑定原件；文档库副本独立保存。当前 XLSX 工具没有原生页面图片，格式检查以读取结构及编辑器为准。
