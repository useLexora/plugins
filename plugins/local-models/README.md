# Lexora Local Models

在本机发现、下载和运行模型，提供对话、图像理解、语音转写、朗读、图像生成和文字识别能力。安装包不包含推理引擎或模型权重。

## 平台支持

需要 **Lexora 0.22.0 及以上版本**。

| 平台 | 支持状态 |
| --- | --- |
| Linux x64 | 支持 |
| Windows x64 | 实验性；原生引擎需 Microsoft Visual C++ x64 运行库 |
| macOS 15+ ARM64 | 实验性；不支持 Intel Mac |

GPU 加速需要相应驱动及足够显存。Windows 和 macOS 的原生引擎以当前用户权限运行，不提供操作系统级文件或网络隔离。

## 使用

1. 在「设置 → 集成 → 本地模型」打开管理页面。
2. 从「发现」搜索 Hugging Face 模型，或在「我的模型」中导入本地文件。
3. 在「推理引擎」中准备对应引擎。引擎与模型文件均就绪后，选择「启用模型」。
4. 在任务模型选择器或相应用途设置中选择模型；对话、语音及生图模型归属「模型服务 → Lexora Local」。

模型参数和文件管理位于详情页；「下载历史」提供进度、取消和重试。每种运行时同时启用一个模型，切换前需等待当前任务结束。

### 对话与图像理解引擎

llama.cpp 的后端与版本分别管理。Linux、Windows 可选 CPU、Vulkan 或 CUDA；macOS 可选 CPU 或 Metal。CUDA 构建的驱动与系统要求见引擎详情，不满足时可改用其他后端。

运行参数将加速方式、上下文与最大输出放在基础设置，线程等参数放在高级设置。新模型使用硬件信息辅助选择初始值；已有配置保持不变。「使用推荐值」只填写草稿，仍可自行修改并保存，不会持续跟随硬件变化。

预算预检区分权重、KV 缓存与预留空间，只提示风险，不禁止保存或自动降低上下文、切换后端。估算不保证启动成功；旧模型缺少元数据、未知架构或显存信息不可用时会明确提示。重新导入同一模型可补充可读取的元数据，原文件和已保存参数保留。

工具与思考能力优先使用模型文件和引擎提供的信息，不要求本地文件带有在线仓库身份。旧模型可重新导入同一文件补齐元数据；正常加载后也会读取引擎声明。无法识别的模板保持未知，不代表不支持；自动识别不保证任务质量，仍可在「模型服务」中手动覆盖能力。Hugging Face 固定版本模型卡的 `capabilities` 对象可提供明确的 `toolCall`、`reasoningOptions`、`input`、`contextWindow` 和 `maxTokens` 声明；名称和标签不直接作为能力开关。

「实际运行」展示当前实例报告的后端、GPU 层数和上下文，不把所选后端当作运行成功。GPU 层数不代表所有运算都在 GPU。硬件采样失败或引擎未提供运行观测时，相关数据会显示未报告。

「检查更新」只更新官方引擎目录，不下载文件或切换当前版本。安装后选择「使用此版本」；旧版仍保留，可按同样方式切回。部分构建为上游预发布版本，请先核对运行要求。

「使用已有引擎」可引用当前平台的 `llama-server` 和同目录配套动态库，不移动或删除原文件；请选择实际构建的后端，并且只运行可信来源的引擎。授权失效后可重新选择文件恢复访问。

模型不兼容时，详情页会提示已知的最低引擎版本；引擎更新无需重新下载模型。运行失败时，先按错误提示检查后端、驱动及模型格式，也可在 Lexora 的日志中搜索 `chat.gpu` 查看受控运行诊断。

## 模型格式

| 用途 | 格式与引擎 |
| --- | --- |
| 对话 | GGUF，支持完整分片；llama.cpp |
| 图像理解 | GGUF 与配套 mmproj；llama.cpp |
| 语音转写 | sherpa-onnx 流式 Zipformer／Zipformer2 |
| 朗读 | Kokoro ONNX 及完整配套资源；sherpa-onnx |
| 图像生成 | Z-Image Turbo 组件，或 LDM 命名的 SD 1.x／SDXL base safetensors；stable-diffusion.cpp |
| 文字识别 | Tesseract LSTM 语言包 |

仅支持已适配架构及完整文件组合。可安装不代表模型适合当前硬件；图片和工具调用能力仍取决于模型与引擎。下载前请核对来源及许可，受限模型需先取得访问资格。

## 数据与安全

- 本地导入默认引用原文件；分片文件需重组时会复制，原件不变。清理模型不会删除外部原件或已安装引擎。
- 文件摘要用于完整性校验，不代表来源可信或获得使用许可。
- 普通卸载保留插件数据；恢复后的外部引用可能需要重新授权。备份不包含引擎和权重。
- 外部 API 在 Lexora「设置 → 模型服务」中配置。

## 构建

需要 Node.js、npm 和相邻的 Lexora 源码；可通过 `LEXORA_REPOSITORY` 指定源码路径。在插件目录执行：

```sh
npm ci
npm test
npm run package
```

编译目录为仓库根目录下的 `dist/local-models/`，安装包为 `dist/local-models-<version>.lexora-extension`。

## 真实长上下文验收

Linux 验收使用真实引擎和 GGUF，可显式选择 CPU、Vulkan 或 CUDA，不随普通单元测试运行。上下文固定为 65,536 token，合成任务材料按模型 tokenizer 校准到约 56K，覆盖文档、日志、代码、长输出、多轮工具与取消恢复。需要支持至少 64K 的模型、完整可执行的引擎目录和足够可用内存；不会自动降低上下文。

```sh
LEXORA_CHAT_LONG_TEST=1 \
LEXORA_CHAT_TEST_BACKEND=cpu \
LEXORA_CHAT_TEST_ENGINE=/path/to/engine-directory \
LEXORA_CHAT_TEST_MODEL=/path/to/model.gguf \
LEXORA_CHAT_TEST_OUTPUT=/path/to/acceptance-output \
node --test --test-timeout=14400000 native/chat/__tests__/chat-long-context.spec.mjs
```

GPU 验收将 `LEXORA_CHAT_TEST_BACKEND` 改为 `vulkan` 或 `cuda`，并使用对应后端的引擎。当前 GPU 采样依赖 NVIDIA 的 `nvidia-smi`，不代表已覆盖其他显卡或操作系统。已知 b12211 及更新构建由运行适配器开启设备与卸载观测日志，不改变 GPU 分配参数。`LEXORA_CHAT_TEST_LOG_VERBOSITY=4` 可用于显式调试观测，默认不添加验收专用参数；计时包含实际日志开销。

结果包含实际 token 数、首段延迟、引擎计时、采样内存、GPU 设备与卸载证据、显存采样及质量检查。显存区分整卡与可获取的自有进程值；单次结果不是性能基准，长输出的结构检查也不能替代人工内容审阅。

## 许可

插件及第三方声明见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。下载的引擎和模型适用各自的许可与使用条件。
