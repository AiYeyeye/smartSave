# 演示素材 / Demo media

README 与使用手册中的截图和视频使用演示书签，展示智栏的实际界面。

The README and user guides use screenshots and a video of Zhilan with demonstration bookmarks.

| 文件 / File | 内容 / Content |
| --- | --- |
| `screenshots/01-bookmarks.png` | 书签目录 / bookmark folders |
| `screenshots/02-search.png` | 本地搜索 / local search |
| `screenshots/03-organize.png` | 整理范围选择 / organization scope selection |
| `screenshots/04-export.png` | 导出设置 / export settings |
| `screenshots/05-privacy.png` | 隐私与规则 / privacy and rules |
| `zhilan-quick-tour.mp4` | 无声操作演示 / silent walkthrough |

## 重新生成 / Regenerate

需要 Chromium、Python Playwright 和支持 H.264 的 FFmpeg。将命令中的路径替换为本机工具路径。

Install Chromium, Python Playwright and FFmpeg with H.264 support, then substitute your executable paths below.

```sh
python tools/brand_assets.py --browser /absolute/path/to/chromium
pnpm --dir extension build
python tools/capture-release-media.py --browser /absolute/path/to/chromium --ffmpeg /absolute/path/to/ffmpeg
python tools/check-docs.py
```

脚本使用临时浏览器配置和合成书签，截图尺寸为 1280×800。界面变化后重新生成相关素材。

The script uses a temporary browser profile and synthetic bookmarks. Screenshots are 1280×800. Regenerate affected media after UI changes.
