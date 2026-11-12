# 任务残留清理

清理旧版已移除任务的本地残留，不影响现有任务和外部文件。

Lexora 官方可选插件；需手动安装，不随宿主默认安装。要求 Lexora 0.22.0 或更新的 0.x 版本（API 4），安装时按清单检查兼容性。

安装并启用后，在「插件」中找到本插件，点击卡片「… → 插件操作 → 清理任务残留…」。没有独立页面或侧栏导航，不需要选择 Space。

宿主扫描并冻结本轮范围，插件面板展示旧版已移除任务的真实数量、跳过数量与删除风险。删除永久不可恢复；不处理活动或已归档任务，不删除用户工作区及外部文件。只有在面板点击「删除」才逐项清理，点击「取消」不提交任何作业。确认期间状态改变的任务会拒绝清理，不自动或定时清理。

插件自己的浮层负责预览、确认、实际处理进度与最终计数。确认前关闭或隐藏面板会取消本轮清理，再次打开不会恢复旧确认；已确认的作业可以在后台继续。从卡片菜单第二项「查看进度与结果」重新打开，查看不会提交清理。已删除、后台处理中、失败与跳过分别计数，后台处理中不代表已删除。

清理期间重复点击清理菜单只恢复面板，不重复提交。再次清理须回到原菜单，重新扫描并在插件面板确认。面板只保留本次应用会话的最近状态，重启后不恢复虚假的进行中状态。

确认后关闭面板或切换页面不取消已受理的核心作业。停用或卸载会撤销插件视图及后续访问，已受理的核心作业仍可能继续处理。结果未知时保留最后确认的计数，不自动重试。

在本插件仓库根目录构建，`LEXORA_SOURCE` 指向包含此能力及开发依赖的 Lexora API 4 源码目录：

```sh
LEXORA_SOURCE=/path/to/Lexora
node "$LEXORA_SOURCE/apps/buddy/extensions/tools.mjs" check plugins/legacy-task-cleanup
node "$LEXORA_SOURCE/apps/buddy/extensions/tools.mjs" build plugins/legacy-task-cleanup dist/legacy-task-cleanup-1.0.0
node "$LEXORA_SOURCE/apps/buddy/extensions/tools.mjs" pack dist/legacy-task-cleanup-1.0.0 dist/legacy-task-cleanup-1.0.0.lexora-extension
```

在「插件 → 安装插件包」选择生成的安装包并审核清理权限。
