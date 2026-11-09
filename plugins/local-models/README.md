# Lexora Local Models

在本机发现、下载和运行模型，提供对话、图像理解、语音转写、朗读、图像生成和文字识别能力。安装包不包含推理引擎或模型权重。

## 平台支持

需要 **Lexora 0.21.0 及以上版本**。

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

## 许可

插件及第三方声明见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。下载的引擎和模型适用各自的许可与使用条件。
