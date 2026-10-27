# Lexora Office

Lexora 的本地 Office 工作台，提供文档（DOCX）、表格（XLSX / CSV）、演示文稿（PPTX）和 PDF 编辑，以及独立的文件管理页面。基于 [GenOffice](https://github.com/genspark-ai/genoffice/tree/8ab58a51433577a1317af4206137cee425b86606)，表格使用 Univer 0.25.1。

## 安装与使用

需要 **支持本地文件编辑的 Lexora 0.17.0 或更高版本**。

1. 在“插件 → 安装插件包”中安装 `office-<version>.lexora-extension`。
2. 进入 **Office**，选择“打开本地文件”直接编辑原件，或新建文档、表格、演示文稿和 PDF 到文档库。
3. 使用“保存”或 Ctrl / Cmd + S 写回当前本地文件；文档库中的文件自动保存。
4. “另存为…”保存到新位置并切换当前文件；“保存副本…”保留当前文件绑定和未保存状态。

文件名旁显示保存位置。未保存修改会暂存为恢复草稿，原文件不会自动更新；关闭前可选择保存、不保存或取消。遇到外部修改或保存失败，当前内容会保留，可重新加载或另存为。CSV 转换为 XLSX 后另行保存。

首页保留文档库、收藏、版本历史和回收站。“新建”由文档库维护；“导入文档库”复制已有文件。打开本地文件和任务产物不会自动入库，保存时更新原文件。

选中文字、单元格或演示对象，使用编辑器原生的“引用”菜单；PDF 也支持选中文字后的浮动按钮。可以引用到已有任务、新任务，或复制引用后粘贴到任务。引用保留当时的内容，不触发保存。

Office 的五个技能与工具共用主 Agent。本地文件的 AI 修改先应用到编辑缓冲，明确保存时才写回原件；导出任务产物不改变原件保存状态。工具支持的操作以能力查询结果为准。安装时会申请文件编辑和剪贴板权限；插件不获取本机文件的绝对路径。

## 功能与限制

- 文档提供排版、表格、绘图、引用与审阅工具栏；邮件合并支持 CSV / XLSX 收件人列表，导出单份 DOCX 或逐条文档 ZIP。
- 表格支持内容与公式、字体与单元格格式、行列与工作表管理、排序筛选、查找替换、冻结和普通批注。CSV 会转换成真实 XLSX。
- 演示文稿提供文本、表格、图表、布局、切换、动画、放映与备注工具栏。
- PDF 支持阅读搜索、中文文字、批注、绘图、表单，以及旋转、插入、提取、合并、拆分和裁切等页面操作。
- 表格中的图片、图表、透视表、条件格式、数据验证等原有部件保留，暂不提供完整的可视编辑。复杂工作簿的部分结构操作会拒绝保存。线程批注、受保护区域、宏和数字签名有额外编辑限制；不支持 1904 日期系统。
- Office 各格式不能保证与 Microsoft Office 完全一致的排版或全部特性保真。公式导出会清除过期缓存，由 Excel / LibreOffice 重算；复杂文件请导出后复核。
- 系统 OCR、证书签名、硬件录制、外部账号及部分原生系统功能不在本插件支持范围内。
- 文档库最多 240 个文件，Office 文件最多 64 MB；XLSX 另限 32 MiB、解压后 96 MiB、250,000 个已存储单元格。

## 构建与打包

需要 Node.js 26+、npm、Git，以及已安装依赖的配套 Lexora 源码。默认使用与本仓库同级的 `Lexora` 目录；其他位置通过 `LEXORA_REPOSITORY` 指定。

在 `plugins/office` 中执行：

```sh
npm ci --ignore-scripts
npm run prepare:editors
npm run lint:fix
npm run type-check
npm test
npm run package
```

`package` 会构建全部编辑器、生成第三方许可声明、校验并打包。安装包输出到本仓库的 `dist/office-<version>.lexora-extension`。单独构建使用 `npm run build`，校验已有 `dist/` 使用 `npm run check`。开发加载也应选择构建后的 `plugins/office/dist/` 目录。

首次准备会下载固定版本的上游源码，校验 SHA-256 并应用插件补丁；后续复用本地缓存。离线构建可通过 `OFFICE_SOURCE_ARCHIVE` 指定相同版本的源码 ZIP，仍须通过校验。最终安装包包含运行所需的编辑器、字体和 WASM，使用时无需下载源码。

使用配套宿主源码调试时，运行 `npm run dev`，在 Lexora 的“插件 → 安装”旁选择“加载开发目录”，加载 `plugins/office/artifacts/dev/`。此目录适配当前本地宿主构建，仅供开发调试；宿主必须具备插件要求的能力。修改后重新运行命令并加载目录。

## 测试

桌面验收复用 Lexora 的隔离 Electron 测试环境，需要先构建宿主和插件包：

```sh
export LEXORA_REPOSITORY=/path/to/Lexora
"$LEXORA_REPOSITORY/node_modules/.bin/playwright" test --config "$PWD/playwright.config.mjs"
```

`OFFICE_PLUGIN_PACKAGE` 可指定待测包，`OFFICE_PREVIOUS_PACKAGE` 可指定旧版本安装包以验证保留数据重装。结果写入 `artifacts/`，可通过 `LEXORA_TEST_ARTIFACT_DIR` 更改。

独立浏览器验收默认使用 Playwright 管理的 Chromium，也可设置 `CHROMIUM_PATH`：

```sh
node --test __tests__/library-ui.test.mjs __tests__/office-lifecycle.test.mjs __tests__/theme-loading.test.mjs
node --test __tests__/clipboard.browser.mjs __tests__/docx-clipboard.test.mjs __tests__/slides-editor.test.mjs
node __tests__/sheets.browser.mjs
node __tests__/office-save.browser.mjs
```

普通验收使用合成文件和模拟模型，不读取个人账号。真实模型验收需显式设置 `OFFICE_REAL_MODEL=1` 或 `OFFICE_SUITE_REAL_MODEL=1`，以及 `OFFICE_REAL_MODEL_SETUP=/path/to/setup.mjs`；该模块导出 `setupRealModel({ instance, app, page, scenario })`，仅为隔离测试实例配置模型。

## 来源与许可

GenOffice 固定提交为 `8ab58a51433577a1317af4206137cee425b86606`。保留其 Apache-2.0 许可与作者声明；部分上游模块包含浏览器运行和宿主接入适配。Lexora Office 是独立插件，不是 GenOffice 官方发行版。详见 `LICENSE`、`NOTICE` 和安装包中的 `THIRD-PARTY-NOTICES.txt`。
