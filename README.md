# Lexora Plugins

Lexora 官方插件源码与插件市场目录。

插件源码按名称放在 `plugins/<name>/`。清单中的 `id` 是稳定身份，升级时保持不变；`author` 独立保存作者署名。使用 `categories` 和 `tags` 分类，不增加分类目录。

## 开发与安装

开发工具与插件创作 Skill 由独立的 Lexora Plugin SDK 提供，无需 npm SDK 包。

使用 SDK 检查、编译和打包后，在 Lexora「插件 → 安装插件包」中选择生成的包。自包含 TS/JS 源码包也可以由 Lexora 编译安装。开发时可通过安装按钮右侧箭头加载插件目录。

## Office 套件

[Lexora Office](plugins/office) 提供文档、表格、演示文稿和 PDF 编辑，以及本地文档库与任务引用。安装、使用与构建方式见插件目录说明。

## 市场目录

`catalog/v1/index.json` 收录插件清单、源码仓库、安装包 URL、大小与 SHA-256。第三方插件保留在作者自己的仓库，发布安装包后通过 PR 提交目录条目。例如 [DSH 状态栏](https://github.com/shanyuhai123/dsh-status)。更新收录版本时一并更新对应的清单和安装包信息。

客户端核验实际安装包与目录记录的一致性，并在安装前展示权限；内容不一致时提示风险，由用户决定是否继续安装。

本仓库插件源码未另行声明时使用根目录的 [MIT 许可证](LICENSE)。[Lexora Office](plugins/office) 使用其目录中的 Apache-2.0 许可证，并保留上游及第三方声明。收录的第三方插件以各自仓库的许可证为准。
