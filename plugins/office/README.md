# Lexora Office

Lexora 的本地 Office 工作台，提供文档（DOCX）、表格（XLSX / CSV）、演示文稿（PPTX）和 PDF 编辑，以及独立的文件管理页面。基于 [GenOffice](https://github.com/genspark-ai/genoffice/tree/8ab58a51433577a1317af4206137cee425b86606)，表格使用 Univer 0.25.1。

## 安装与使用

需要 **Lexora 0.16.0 或更高版本**。

1. 在 Lexora 的“插件 → 安装插件包”中安装 `office-<version>.lexora-extension`。
2. 点击侧栏的 **Office** 图标，使用首页卡片新建文档、表格、演示文稿和 PDF，或导入本地文件。
3. 在编辑页修改内容；修改自动保存到文档库，也可点击“保存”或按 Ctrl / Cmd + S。
4. 编辑页的文件菜单提供“导出”“另存副本”和“重新打开”；保存按钮与 Ctrl / Cmd + S 均可立即保存。

插件安装时会申请剪贴板读、写权限，用于在文档、表格中复制和粘贴文字与格式。仅当前前台、聚焦的编辑视图可使用这些接口。

导入会创建文档库副本，编辑和自动保存不会覆盖导入源文件。管理页支持搜索、类型筛选、排序、收藏、重命名、复制、版本恢复、回收站和彻底删除。返回文档库时保留浏览和选择状态；更多操作位于每行末尾，版本历史在侧栏中查看。每个文件保留最近 12 个版本；回收站也占用文档库容量。保存失败时保留当前修改，离开前可以继续编辑、导出或明确放弃。

选中文字、单元格或演示对象，点击顶部“引用”，然后在任务中提问。独立 Office 页面可选择引用到已打开的分屏、新任务，或复制引用后粘贴到任务；可定位的剪贴板引用在本次 Lexora 窗口会话内有效，重启后请重新引用。Office 技能与工具可读取引用目标，修改支持的文字或单元格并保存到文档库；不会另外启动一套 AI 对话。

套件提供 `office`、`docx`、`xlsx`、`pptx`、`pdf` 五个技能，共用主 Agent。工具支持新建、查库、版本管理、按格式读取与编辑、连续写回及任务产物交付；PDF 和演示文稿可返回渲染图片供主 Agent 检查。文档支持正文块与格式操作，表格支持数据/格式批次及工作表结构，演示文稿支持原子布局操作，PDF 支持正文、批注、表单和页面操作。具体能力以工具查询结果为准。引用固定保留捕获时的文字；读取当前文档时会验证定位和原文。编辑目标只在当前任务执行中有效。自身编辑后可继续读取同一目标；用户手动修改或其他页面更新会触发版本冲突。

同一产物或文件反复打开会复用其文档库记录。明确“导入文件”或“另存副本”会创建独立副本。

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
