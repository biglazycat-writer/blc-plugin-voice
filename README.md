# 语音工坊 · 大懒猫创作平台插件

为大懒猫创作平台提供文章朗读能力，并在插件页面将工作区文章制作成播客。

**简体中文** | [English](README.en.md)

## 开始使用

1. 在桌面端安装 `dist-package/blc-plugin-voice-<版本>.tgz`，准备依赖并启用插件。
2. 在文章工具栏点击「朗读文章」，直接朗读整篇文章；有多个语音插件时，为本次朗读选择一个。
3. 打开「播客制作」，搜索并选择工作区文章，配置节目风格、时长与音色，生成脚本并合成音频。

产品提供统一朗读 API，语音合成由插件实现。插件设置中可以试听音色、下载本地模型，并为朗读或播客角色配置音色。
更新旧版时直接安装新版包，保留原有模型与设置。

## 功能

- 文章工具栏直接朗读整篇文章，PDF 文字选择工具栏可朗读选中文字。
- 播客来源支持工作区文章、当前编辑中的文章和粘贴文本。
- 支持单人独白与双人对谈，可设置时长、语速及主持人和嘉宾音色。
- 使用产品 AI 或本地规则生成脚本，脚本可逐句编辑。
- 本地合成音频可试听，并导出 WAV 或 MP3。
- 支持系统语音引擎与 sherpa-onnx 本地模型，音色与模型在插件设置中管理。

工作区文章使用已保存的内容；从当前文章打开插件时，可选择包含未保存修改的版本。
语音合成在本机完成；启用 AI 脚本生成时，素材会发送给产品中配置的 AI 服务。

## 开发与验证

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run package
```

要求宿主 API 1 revision 5；运行环境与客户端要求见 `package.json`。
测试涵盖提供者接口、文章读取与播客制作，在系统支持时执行真实语音合成。

## 接口细节

清单通过 `contributes.providers` 声明 `speech.tts` v1，绑定 `speech-provider` 服务。
产品通过 `provider_id: "blc-plugin-voice:speech.tts"` 获取可播放的音频，不依赖插件页面。产品没有默认的语音合成实现。
第三方语音插件可实现同一 [SDK 能力契约](https://github.com/biglazycat-writer/blc-plugin-sdk/blob/main/CAPABILITIES.md)。

`main` 视图用于播客制作，`settings` 视图用于音色和模型设置。
文章选择通过公开的工作区资源 API，当前编辑稿通过公开的文稿导出 API 读取。

AI 脚本生成通过 SDK 的 `ctx.ai.generate()` 调用平台默认文本模型，插件只构造播客提示词和处理生成结果，无需配置模型地址或 API Key。
平台模型不可用或生成失败时显示原因；关闭「使用平台 AI 生成脚本」可明确选择本地规则处理。

## 文档与限制

开发约定见 [AGENTS.md](AGENTS.md)，验证见 [提供者测试](tests/provider.test.mjs) 与 [文章测试](tests/articles.test.mjs)。
可用的系统音色取决于操作系统；本地模型下载需要网络并可配置镜像。引擎说明见 [CHANGELOG](CHANGELOG.md)。
