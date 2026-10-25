# 数据、格式与验收

先明确字段、单位、来源和输出范围。ID/邮编/电话等保留文本和前导零，金额和计数使用数值，布尔值保持布尔；缺失值用 null，不随意当作零。日期写入时核对格式及工作簿日期系统，不能只看显示文本。

新建表的最小数据操作（sheetId 来自 get_workbook_context）：

```json
{"sheetId":"返回的 sheetId","range":"A1:B3","values":[["项目","金额"],["测试",12],["合计",{"formula":"=SUM(B2:B2)"}]]}
```

表头 format_range 示例：

```json
{"sheetId":"返回的 sheetId","range":"A1:B1","format":{"bold":true,"background":"#E8F0FE"}}
```

批次格式是 `{operations:[{operation:"set_cells",input:{...}},{operation:"format_range",input:{...}}],dryRun:true}`。先验证，提交时去掉 dryRun。批次只处理同一工作表，最多 50 项/10,000 格；单范围最多 2,000 格，values 尺寸须与 A1 范围一致。更大数据按不重叠范围分批，记录实际完成范围。

坐标约定：范围是 A1；行列操作 index 与 sort_range.column 为 0-based，精确字段看 capability schema。删除行列/工作表前读清结构和依赖，保护、隐私或合并限制被拒绝时不要绕过。

结果核对：

- read_range 回读关键值、空值、公式串；read_formats 检查单位、数字格式、表头和边界。
- check_workbook 看结构、合并、冻结及缓存错误。公式存在与公式结果正确是两件事；尚未在计算引擎重算应如实说明。
- 未请求的工作表、图表、透视表、验证或其它 OOXML 对象应保留。当前工具不创建/编辑图表、透视表、条件格式；不要宣称能力齐全。
- 用户需要外部文件时 export。需要 Excel/LibreOffice 兼容性验收而本轮未运行目标应用时，不声称已通过。
