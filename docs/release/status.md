# 发布状态 / Release status

当前版本为 `0.1.0` 开发候选。源码、测试和候选包可供检查；正式商店发布仍受人工验收门限制。当前 manifest 最低为 Chrome / Edge 116，工具栏入口是网页覆盖侧栏或浏览器侧栏，长工作台在 options 页面。语言、明暗和主题色支持本地保存及浏览器同步。

Version `0.1.0` is a development candidate. Source, tests and candidate packages are reviewable, but store release remains blocked by manual acceptance. The manifest requires Chrome / Edge 116. The toolbar opens a webpage overlay or native side panel; longer workspaces use the options page. Language, mode and accent preferences persist locally and can sync.

## 可复现的检查 / Reproducible checks

Use the commands in [extension development](../../extension/README.md) and the [release checklist](checklist.md). Unit/component tests use synthetic data. Build integration tests inspect actual generated assets. Opt-in isolated Chromium scripts cover defined flows and do not certify everyday branded-browser profiles or all real providers. Test counts and hashes belong to each run, not permanent product claims.

单元/组件测试使用合成数据，构建集成测试检查实际产物。按需运行的隔离 Chromium 脚本覆盖特定流程，不等于日常浏览器或所有真实模型已验收。测试数量和哈希随版本变化，应记录在对应运行结果中。

`release:source` regenerates ignored `extension/release-candidate.json`, containing source/artifact hashes and source errors. `release:ready` additionally enforces the manual gates below. `python tools/package-release.py --candidate` rebuilds production assets and writes `.local/releases/`; candidate packaging is not release approval.

## 待完成的人工门 / Outstanding manual gates

- Chrome restart/reliability and Edge no-page/restart behavior.
- Real-provider model tasks, failure paths and manually labeled evaluation.
- Recovery, privacy/network and file-permission inspection.
- Windows browser/version, theme, accessibility and performance acceptance.
- Approved minimum-browser matrix, independent review and user acceptance.

对应项目由 `extension/checks/release.mjs` 维护，目前仍阻止正式发布。没有可确认的 200 条人工模型评测集，也不宣称真实分类准确率或耗时达标。隐私页部署与商店链接见 [publisher.json](../store/publisher.json)，空值表示尚未确认。

These gates remain enforced in `extension/checks/release.mjs`. No completed 200-item manually labeled provider evaluation or verified real-provider latency/accuracy target is claimed. Deployment/store URLs are recorded in the publisher metadata; null means unconfirmed.

## Historical evidence

An early file-access probe recorded bounded Chrome success, permission refusal without a write, and reauthorized background output with its experiment page closed. It was an isolated prototype, not production bookmark integration or completion of the browser matrix. Original raw reports remain private; they are not dependencies of public builds or evidence that current release gates passed.

早期文件访问实验曾记录 Chrome 下有限的成功、拒绝授权时未写入、重新授权后关实验页的后台输出。它不代表当前生产版及浏览器矩阵验收通过。原始报告在本机私有归档中，公开构建不依赖这些材料。
