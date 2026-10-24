<div align="center">
  <img src="extension/public/icons/icon-128.png" alt="Zhilan" width="80" height="80">
  <h1>Zhilan · 智栏</h1>
  <p><strong>Keep your bookmarks organized. Find them when you need them.</strong></p>
  <p>For Chrome / Edge · Automatic filing · AI search · Bulk organization</p>
</div>

<p align="center">
  <a href="README.md">简体中文</a> · English<br>
  <a href="#get-started">Get started</a> ·
  <a href="docs/guides/user-guide.en.md">User guide</a> ·
  <a href="docs/media/zhilan-quick-tour.mp4">Demo video</a> ·
  <a href="https://github.com/AiYeyeye/smartSave/issues">Report an issue</a>
</p>

![Zhilan bookmark sidebar](docs/media/screenshots/01-bookmarks.png)

## What you can do

Saving a page is easy. Finding it months later can take a little more work. Zhilan brings saving, searching and organizing together so you spend less time browsing folders.

| Feature | How it helps |
| --- | --- |
| File bookmarks as you save | Click the browser's star and let website rules or your configured AI suggest where it belongs. Correct or undo a misplaced bookmark. |
| Find pages in your own words | Describe what you remember, or search by title, URL, Chinese pinyin or initials. |
| Find previously visited pages | Enable optional history search, filter by time, title or URL, or explicitly ask AI to interpret a description. Bookmark a result when you find it. |
| Organize a collection | Select folders, review the AI's suggestions and choose whether to apply them. Close the page while suggestions are generated and return later. |
| Bookmark check | Check links and duplicates in the sidebar, optionally weekly; preview and confirm a batch cleanup. |
| Import, export and recover | Work with common bookmark formats, inspect recent operations and preview undo or recovery. |

Your bookmarks stay in your browser. Zhilan helps you manage them directly, without another account or a move to a separate bookmark service.

<details>
<summary>See search and organization</summary>

### Bookmark search

![Zhilan search](docs/media/screenshots/02-search.png)

### Bulk organization

![Zhilan organization workspace](docs/media/screenshots/03-organize.png)

Screenshots use demonstration bookmarks.

</details>

## Get started

You need **Chrome / Edge 127+**.

1. Download **zhilan-0.1.0-candidate.zip** from the [download page](https://github.com/AiYeyeye/smartSave/releases/tag/v0.1.0-preview.20261024.2) and extract it to a permanent folder.
2. Open `chrome://extensions` or `edge://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted folder containing `manifest.json`.
4. Pin Zhilan to the toolbar and click its icon to open your bookmarks.

This is a preview build. Installation needs no Node or pnpm. See [installation](docs/guides/install.md) for updates and [development](extension/README.md) to build from source.

You can browse, search and manage bookmarks without connecting AI. For automatic classification and AI search, add an existing model service under **Settings → AI services**, then choose a model for each feature. After installation, the sidebar shows steps for AI setup, bookmarking, search and organization. Dismiss them when ready; reopen them from Getting started in sidebar settings.

Supported connections include OpenAI-compatible services, OpenAI Responses, Anthropic, Gemini and local services such as Ollama and LM Studio. See [model setup](docs/guides/model-setup.en.md) for configuration details.

## Everyday shortcuts

| Action | How |
| --- | --- |
| Open search | `Alt+Shift+K` |
| Search from the address bar | Type `zl`, press Tab or Space, then enter your query |
| Focus search inside Zhilan | `Ctrl+K`, or `⌘K` on Mac |
| Choose a sidebar | Select the webpage overlay or browser side panel in Appearance |
| Change language or theme | Quick settings and Appearance offer Chinese/English, light/dark mode and accent colors |

You can change conflicting shortcuts in your browser's extension shortcut settings.

## Your bookmarks and privacy

Ordinary search runs locally. When you enable AI, relevant bookmark information goes directly to the model service you choose. You can exclude folders from AI processing. Language and appearance preferences can sync through your browser; service keys and rules stay on your device.

Read the [privacy policy](docs/privacy.en.md) for details.

## Documentation and contributing

- [User guide](docs/guides/user-guide.en.md) · [Installation](docs/guides/install.md) · [Recovery](docs/guides/recovery.md)
- [Documentation index](docs/README.md) · [Development](extension/README.md) · [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Security](SECURITY.md)

Issues, suggestions and pull requests are welcome.

## License

Licensed under [PolyForm Noncommercial 1.0.0](LICENSE).

Maintainer: Astraxine · [Contact](mailto:mmgnosit@gmail.com)
