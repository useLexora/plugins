# Lexora Plugins

Lexora 插件源码、市场目录与分发入口。

插件源码按名称放在 `plugins/<name>/`。清单中的 `id` 是稳定身份，升级时保持不变；`author` 独立保存作者署名。使用 `categories` 和 `tags` 分类，不增加分类目录。

## 开发与安装

此仓库只保存 `plugins/` 源码和 `catalog/` 市场索引。开发工具与插件创作 Skill 由独立的 Lexora Plugin SDK 提供，无需 npm SDK 包。

使用 SDK 检查、编译和打包后，在 Lexora「插件 → 安装插件包」中选择生成的包。自包含 TS/JS 源码包也可以由 Lexora 编译安装。开发时可通过安装按钮右侧箭头加载插件目录。

## Office 套件

[Lexora Office](plugins/office) 提供文档、表格、演示文稿和 PDF 编辑，以及本地文档库与任务引用。安装、使用与构建方式见插件目录说明。

## 市场目录

`catalog/v1/index.json` 包含版本、兼容范围、分类和安装包信息，由 SDK 打包命令生成。发布时先将安装包上传到清单对应的 GitHub Release，再同步市场索引。

客户端读取目录并下载安装包，不克隆源码仓库或执行构建脚本。

插件未另行声明时使用根目录的 [MIT 许可证](LICENSE)。[Lexora Office](plugins/office) 使用其目录中的 Apache-2.0 许可证，并保留上游及第三方声明。
