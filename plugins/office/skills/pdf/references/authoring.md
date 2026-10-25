# 固定布局创作

PDF 点为 1/72 英寸；insert_text 坐标从显示页面左上角起算。先 inspect 取得实际尺寸，在页面内留出边距，使用 max_width 控制文本框宽度。长段落按可读性分块，不期待其他段落自动重排。

空白 PDF 的首个正文示例（按 capabilities 确认字体可用）：

```json
{"page":1,"x":72,"y":72,"text":"Project brief","font_size":24,"font":"arial","bold":true,"color":"#174879","max_width":450}
```

insert_text 后保存，再用 read_pages 读取内容；继续编辑插入对象或批注前重新读最新 ID。保存会改变一些临时 ID，不能沿用旧 ID。新插入页面保存后才能读取和渲染，页码也必须重新核对。

apply_ops 最多 50 项，可 dry_run 验证，然后按最新 revision 提交。它支持的操作以工具 schema 为准，不把原版 GenOffice 的全部操作都当作已接入。页面编辑应先读页序，避免删除或旋转了错误页。

只读、加密或缺少可编辑字形时尊重能力返回，说明具体限制。正文改写不会自动重排相邻段落；即使文本读取正确也要渲染检查。render 每次选择一页，scale 在 0.5–2，最长边受限；分次看实际改动页即可。
