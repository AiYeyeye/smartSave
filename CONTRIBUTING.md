# 参与贡献 / Contributing

欢迎通过 [Issues](https://github.com/AiYeyeye/smartSave/issues) 反馈问题、讨论功能，通过 Pull Request 贡献修复。安全问题请先看 [SECURITY.md](SECURITY.md)。自有代码采用 [PolyForm Noncommercial 1.0.0](LICENSE)，未经单独授权不得商用；第三方依赖保留各自许可证。详见 [许可说明](docs/licensing.md)。

## 开始开发

需要 Node.js >=22.12、pnpm 11.7.0。

```sh
git clone https://github.com/AiYeyeye/smartSave.git
cd smartSave
pnpm --dir extension install --frozen-lockfile
pnpm --dir extension build
```

在独立测试浏览器配置中加载 `extension/dist`，使用演示书签。详细结构和测试入口见 [开发说明](extension/README.md)；AI 助手还应遵守 [AGENTS.md](AGENTS.md) 和 `.trellis/spec/` 对应层规范。

## 提交修改

1. 较大的功能先开 Issue 说明场景和预期行为；小修复可直接提交 PR。
2. 保持改动集中，更新受影响的中英文文案和文档。修复行为问题时加入有意义的回归测试。
3. 浏览器原生书签是事实源；沿用统一写入、预览、确认和恢复路径。模型输出不能直接执行代码或绕过写入校验。
4. 新增网络访问或依赖时，同步更新隐私政策、权限说明、锁文件和第三方许可。
5. 运行下列检查；集成测试会重建产物，最终生产构建必须放在其后。

```sh
pnpm --dir extension lint
pnpm --dir extension typecheck
pnpm --dir extension test --maxWorkers=2
pnpm --dir extension test:integration
pnpm --dir extension build
pnpm --dir extension release:source
python tools/check-docs.py
```

PR 写明问题、最终行为和验证结果。截图用虚构书签；请勿提交 API Key、个人收藏、模型请求正文、浏览器配置、私有评测集或本机绝对路径。格式化只处理本次修改的文件，避免改写他人的工作。

## English

Use Node.js >=22.12 and pnpm 11.7.0; build and check with the commands above. Test in a disposable browser profile with synthetic bookmarks. Discuss major changes in an issue, keep PRs focused, describe validation, and update user docs and translations when behavior changes. Preserve the shared native mutation/confirmation/recovery boundary. Update privacy disclosures and dependency notices when adding network access or dependencies. Never commit credentials, personal bookmarks, private diagnostics or browser profiles. Contributions use PolyForm Noncommercial 1.0.0, without copyright assignment or an automatic commercial relicensing grant.
