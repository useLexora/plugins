---
name: pdf
description: 使用 Lexora Office 创建、读取、修改和交付 PDF，处理固定页面正文、批注、表单、页操作及渲染检查；适用于用户引用或 Office 文档库中的 PDF。
---

# PDF

领域读取操作统一通过 `read({targetId,query:{operation:"操作名",input:"参数 JSON 对象字符串"}})` 调用，它们不是独立注册工具。解释、分析或检查任务止于读取和必要的渲染；新建、修改、管理或导出只在用户要求相应操作时进行。创建或修改文件任务以检查和产物交付收尾。

用 `lexora_tool_search` 搜索 Office。只阅读历史摘录先用宿主 `lexora_reference_list`，再按返回的 `sourceMessageId`、`kind`、`referenceId` 调用 `lexora_reference_read`；检查或修改当前引用对象走 `references → read(sourceMessageId,referenceId)`，由工具验证原文和定位后绑定目标；库文件走 `documents → read(documentId)`；新建用 `create(kind:"pdf",name)`。取得 targetId/revision 后调用 `capabilities(targetId)`，获取当前只读状态、真实 read/edit schema 和渲染参数。工具不接入另一套 AI。

PDF 是固定布局。先 `read(targetId,query:{operation:"inspect"})` 检查页尺寸、旋转、属性和字体，再用 `read_pages` 读取正文；扫描页无自动 OCR，不能把空文本当空白页面。需要文字定位时用 `search_text`，不要根据截图猜字串。

`edit(targetId,expectedRevision,operation,input)` 中 input 是 JSON 对象字符串。正文新增用 insert_text，准确替换用 edit_text/edit_block；edit_text 的文字有多个匹配时必须明确 occurrence；edit_block 的 paragraph_text 必须能唯一定位整段。先读取原文和当前页码再写入，保留用户未要求修改的区域。批注、表单、页操作和 apply_ops 仅使用 capabilities 中公布的 schema。

自己的修改后继续 `read(targetId,query)` 检查最新保存内容，使用最新 revision；原引用仍是快照。不要每步要求用户重新引用。用户手改造成版本冲突时检查文档并重新打开明确 documentId，勿重试旧修改。

完成后读正文/批注/表单结果，对改动页面调用 `render(targetId,input:'{"page":1}')` 检查溢出、遮挡、字体和可读性，然后 `export` 发布任务产物。保存只更新文档库，导入原件不变。

创建与版式工作读 [固定布局创作](references/authoring.md)。
