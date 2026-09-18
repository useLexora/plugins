# Lexora Plugins

Lexora 插件源码、市场目录与分发入口。首个插件：[喝水提醒小助手](plugins/water-reminder/README.md)。

插件源码按名称放在 `plugins/<name>/`，清单中的 `id` 使用稳定的 `发布者.插件名`，例如 `lexora.water-reminder`。使用 `categories` 和 `tags` 分类，不增加分类目录。

## 开发与安装

此仓库只保存 `plugins/` 源码和 `catalog/` 市场索引。开发工具与插件创作 Skill 由独立的 Lexora Plugin SDK 提供，无需 npm SDK 包。

使用 SDK 检查、编译和打包后，在 Lexora「插件 → 安装插件包」中选择生成的包。自包含 TS/JS 源码包也可以由 Lexora 编译安装。开发时可通过安装按钮右侧箭头加载插件目录。

## 市场目录

`catalog/v1/index.json` 包含版本、兼容范围、分类和安装包信息，由 SDK 打包命令生成。发布时先将安装包上传到清单对应的 GitHub Release，再同步市场索引。

客户端读取目录并下载安装包，不克隆源码仓库或执行构建脚本。

全部插件使用根目录的 [MIT 许可证](LICENSE)，安装包自动携带同一份许可证。
