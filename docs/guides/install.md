# 安装智栏 / Install Zhilan

智栏支持 Chrome / Edge 127+。源代码采用 [PolyForm Noncommercial 1.0.0](../../LICENSE) 许可证，仅供非商业用途使用。

## 下载 ZIP 安装

1. 在 [下载页面](https://github.com/AiYeyeye/smartSave/releases/tag/v0.1.0-preview.20261024.1) 下载 **zhilan-0.1.0-candidate.zip**，不要选择 GitHub 自动生成的 Source code 压缩包。
2. 解压到固定文件夹。该文件夹内应直接包含 `manifest.json`，安装后请保留它。
3. 打开 `chrome://extensions` 或 `edge://extensions`，开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择上面的文件夹。
5. 将智栏固定到工具栏，点击图标打开侧栏。无需模型即可浏览、管理、本地搜索和手动导出；需要 AI 时，再去“AI 服务”连接已有的服务并分配模型。

安装 ZIP 无需 Node 或 pnpm。当前提供候选版供试用，尚未完成全部正式发布人工检查。

默认在网页左侧打开浮层；在“外观”可切换为浏览器侧边栏。浏览器内部页面使用侧边栏。

从源码构建的环境要求和命令见 [扩展开发文档](../../extension/README.md)。构建完成后加载 `extension/dist`，不是整个源码仓库。

## 更新、卸载与故障

更新时先暂停新任务与自动输出，将新版 ZIP 解压覆盖原安装目录，再在扩展管理页点击“重新加载”。保持目录和扩展 ID 稳定；重新加载前未保存的临时密钥可能丢失。从源码安装则先重新构建。

卸载会删除扩展本地设置、密钥、规则和恢复记录；不会由智栏主动删除原生书签和已导出的文件。**操作结果未知时，先看 [恢复说明](recovery.md)，不要卸载或清空存储。**

扩展图标打不开时，检查是否加载了正确的 dist、查看扩展错误，并尝试浏览器侧边栏。快捷键冲突请到 `chrome://extensions/shortcuts` / `edge://extensions/shortcuts` 调整。

开发验证命令见 [开发文档](../../extension/README.md)，日常用法见 [简明手册](user-guide.md)。

## Install in English

Requires Chrome / Edge 127+. Source is available for noncommercial use under [PolyForm Noncommercial 1.0.0](../../LICENSE).

1. Download **zhilan-0.1.0-candidate.zip** from the [download page](https://github.com/AiYeyeye/smartSave/releases/tag/v0.1.0-preview.20261024.1), rather than GitHub's automatic Source code archives.
2. Extract it to a permanent folder with `manifest.json` directly inside. Keep that folder after installation.
3. Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, and select **Load unpacked**.
4. Select the extracted folder and pin Zhilan to the toolbar. Local bookmark functions need no model; connect an existing provider under **AI services** when needed.

The install ZIP needs no Node or pnpm. This preview has not completed all manual release checks. To build from source, use the [development guide](../../extension/README.md) and load `extension/dist`.

To update, pause tasks and automatic exports, extract the new ZIP over the same installation folder, then click **Reload** in the extension manager. Keep the path and extension ID stable. Unsaved temporary keys may be lost. Preserve recovery records before clearing data or uninstalling; see [recovery](recovery.md) for uncertain operations.
