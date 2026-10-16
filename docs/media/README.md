# 演示素材

素材用于 README、使用手册和 Chrome Web Store。全部书签为虚构的演示数据，网址位于 `demo.example.test`；没有读取用户日常浏览器配置或使用真实 API Key。

## 文件

- `screenshots/01-bookmarks.png`：原生书签目录。
- `screenshots/02-search.png`：本地“流程图”搜索。
- `screenshots/03-organize.png`：AI 整理范围入口，未伪造生成结果。
- `screenshots/04-export.png`：导出范围和格式入口。
- `screenshots/05-privacy.png`：隐私和规则设置。
- `zhilan-quick-tour.mp4`：约半分钟无声操作演示；[分镜与可选旁白](video-script.md)。
- `store-tile-440x280.png`、`store-marquee-1400x560.png`：小宣传图及可选横幅，复用项目已有标识和配色。
- `capture-evidence.json`：浏览器版本、生产脚本哈希、网络请求计数和素材哈希。它不是真实模型质量或商店审核证据。

截图为 1280×800 的生产扩展选项页，没有拼接界面或模拟 AI 成功结果；侧栏与完整工作台共用生产组件。图标来自 `extension/ui/theme.css` 的现有 `.zh-logo` 书签几何形状。未采用 `ui/` 中权属尚待确认的设计参考图。

## 重新生成

需要现有 Chromium、Python Playwright，以及可转换 H.264 MP4 的 FFmpeg；脚本不会下载浏览器或工具。传入你自己机器上的绝对路径。

```sh
python tools/brand_assets.py --browser /absolute/path/to/chromium
pnpm --dir extension build
python tools/capture-release-media.py --browser /absolute/path/to/chromium --ffmpeg /absolute/path/to/ffmpeg
python tools/check-docs.py
```

生成过程在临时目录复制未修改的生产扩展、建立新浏览器配置并创建 13 条演示书签，拦截外部网页请求。它只在该配置内写入演示数据，不触碰日常书签。默认不配置 AI，也不生成虚假的模型整理方案；生产源码变化后应重新截图。没有 FFmpeg 时输出 WebM，可另行转换。

上传商店前逐张检查显示内容和尺寸；按 Google 后台的实际要求选择图片。商店视频字段使用 YouTube 链接，本地 MP4 尚未上传。
