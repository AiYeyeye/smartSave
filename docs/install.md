# 安装智栏 / Install Zhilan

当前为未上架的 `0.1.0` 开发候选。源代码公开，仅限 [许可证](../LICENSE) 允许的非商业用途；商用请联系维护者。Chrome Web Store 链接将在正式发布后补充。

## 从源码安装

需要 Node.js >=22.12、pnpm 11.7.0，以及 Chrome / Edge 116+。最低版本来自 manifest 与发布检查器，不等于所有版本已验收。

```sh
git clone https://github.com/AiYeyeye/smartSave.git
cd smartSave
pnpm --dir extension install --frozen-lockfile
pnpm --dir extension build
```

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 开启“开发者模式”，点击“加载已解压的扩展”，选择仓库中的 **`extension/dist`**，不是整个仓库。
3. 将智栏固定到工具栏，点击图标打开侧栏。默认是网页左侧浮层；在“外观”可切换为浏览器侧边栏。浏览器内部页面使用侧边栏。
4. 无需模型即可浏览、管理、本地搜索和手动导出。需要 AI 时，再去“AI 服务”连接你已有的服务并分配模型。

下载候选 ZIP 后，先解压到固定目录，再加载该目录；ZIP 内根目录应直接有 `manifest.json`。开发和验收使用独立配置及演示书签。

## 更新、卸载与故障

源码更新后重新构建，在扩展管理页点击“重新加载”。测试升级时保持目录和扩展 ID 稳定，并先暂停新任务与自动输出。重新加载前未保存的临时密钥可能丢失。

卸载会删除扩展本地设置、密钥、规则和恢复记录；不会由智栏主动删除原生书签和已导出的文件。**操作结果未知时，先看 [恢复说明](recovery.md)，不要卸载或清空存储。**

扩展图标打不开时，检查是否加载了正确的 dist、查看扩展错误，并尝试浏览器侧边栏。快捷键冲突请到 `chrome://extensions/shortcuts` / `edge://extensions/shortcuts` 调整。

开发验证命令见 [开发文档](../extension/README.md)，日常用法见 [简明手册](user-guide.md)。

English: build with the commands above, open your browser's extension manager, enable Developer mode and load `extension/dist`. Pin the toolbar icon. Chrome/Edge 116+ is the declared minimum, not a complete compatibility claim. Local bookmark functions need no model. Rebuild and reload to update; keep the path/ID stable for upgrade tests. Preserve recovery records before clearing data or uninstalling.
