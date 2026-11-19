# Voice Workshop for BigLazyCat Creator

This plugin reads articles aloud from the desktop toolbar and turns workspace articles into podcasts in its own view.

[简体中文](README.md) | **English**

## Get started

1. Install `dist-package/blc-plugin-voice-<version>.tgz`, prepare dependencies and enable the plugin.
2. Click “朗读文章” (read article) in the toolbar to hear the entire article. Choose a plugin for the operation when several are available.
3. Open “播客制作” (podcast production), search for an article, choose the format, duration and voices, then generate a script and render audio.

The product supplies the speech API; plugins perform synthesis. Manage voices and download local models in settings.
Install updates over the existing package to preserve models and settings.

## Features

- Read entire articles from the native toolbar, or selected PDF text from its selection toolbar.
- Create podcasts from saved workspace articles, the current editor or pasted text.
- Configure solo narration or two-person conversations, duration, speed and speaker voices.
- Generate scripts with the product's AI or local rules, then edit individual lines.
- Preview locally synthesized audio and export WAV or MP3.
- Use system speech engines or sherpa-onnx models, with voice and model management in settings.

Workspace articles use saved content. When opened from an article, the plugin can also use the current editor's unsaved changes.
Synthesis runs locally. AI script generation sends source material to the AI service configured in the product.

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run package
```

This plugin requires host API 1 revision 5. Runtime and client requirements are in `package.json`.
Tests cover the provider contract, article reads and podcast workflows, including real synthesis when a system engine is available.

## Integration

`contributes.providers` declares `speech.tts` v1 on `speech-provider`.
The product uses `provider_id: "blc-plugin-voice:speech.tts"` to receive playable audio independently of the plugin view. It has no default speech synthesis implementation.
Third-party plugins can implement the same [SDK capability contract](https://github.com/biglazycat-writer/blc-plugin-sdk/blob/main/CAPABILITIES.md).

The `main` view is for podcast production; `settings` opens voice and model management.
Article selection uses public workspace resource APIs, while the current editor is read through the public document export API.

AI script generation uses the SDK's general `ctx.ai.generate()` interface with the platform's default text model. The plugin supplies podcast prompts and processes the returned text, with no separate model endpoint or API key settings.
Generation failures are shown to the user. Turn off platform AI generation to explicitly choose local script rules.

## Documentation and limits

See [repository conventions](AGENTS.md), [provider tests](tests/provider.test.mjs) and [article tests](tests/articles.test.mjs).
System voice availability depends on the OS. Local model downloads need network access and support mirrors; engine details are in the [changelog](CHANGELOG.md).
