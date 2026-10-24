# 参与贡献 / Contributing

欢迎通过 [Issues](https://github.com/AiYeyeye/smartSave/issues) 反馈问题、讨论功能，通过 Pull Request 贡献修复。安全问题请先看 [SECURITY.md](SECURITY.md)。自有代码采用 [PolyForm Noncommercial 1.0.0](LICENSE)，未经单独授权不得商用；第三方依赖保留各自许可证。详见 [许可说明](docs/legal/licensing.md)。提交贡献前请阅读 [贡献者授权](#贡献者授权)。

## 开始开发

需要 Node.js >=22.12、pnpm 11.7.0。

```sh
git clone https://github.com/AiYeyeye/smartSave.git
cd smartSave
pnpm --dir extension install --frozen-lockfile
pnpm --dir extension build
```

在独立测试浏览器配置中加载 `extension/dist`，使用演示书签。详细结构和测试入口见 [开发说明](extension/README.md)；AI 助手还应遵守 [AGENTS.md](AGENTS.md) （[中文版](AGENTS.zh-CN.md)）、[公共架构](docs/development/architecture.md) 和 [目录规则](docs/development/repository-layout.md)。

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
python tools/check-repository.py
python -m unittest discover -s tools/tests
```

PR 写明问题、最终行为和验证结果。截图用虚构书签；请勿提交 API Key、个人收藏、模型请求正文、浏览器配置、私有评测集或本机绝对路径。格式化只处理本次修改的文件，避免改写他人的工作。

## 贡献者授权

自 2026 年 10 月 23 日起，向本仓库提交贡献（包括 Pull Request、补丁、代码、文档、翻译、图片和其他素材），即表示你同意以下条款：

1. **版权仍归你。** 本条款不要求转让版权。
2. **公开许可不变。** 贡献合并后，公众仍按 [PolyForm Noncommercial 1.0.0](LICENSE) 使用。
3. **向维护者授权。** 你授予 Astraxine 及其权利继受者一项全球范围、永久、不可撤销、非独占、免版税的许可：可以使用、复制、修改、公开展示、分发和再许可你的贡献，并据此创作衍生作品，包括用于商业产品和付费服务，或按 PolyForm Noncommercial 以外的条款授权他人使用。该许可可以转让。
4. **专利。** 如果你拥有或控制的专利权利要求会因你的贡献本身，或因贡献与本项目结合而必然被实施，你就这些权利要求授予与第 3 条范围相同的许可。
5. **你有权提交。** 你确认贡献是你的原创作品，或你有权按本条款提交；如果贡献的权利属于雇主或他人，你已取得必要许可。贡献中包含第三方代码或素材时，请在 PR 中写明来源和许可证。
6. **无义务、无担保。** 维护者没有义务采用你的贡献。除第 5 条外，贡献按“原样”提供，不附带任何担保。
7. **此前的贡献。** 2026 年 10 月 23 日前提交的贡献不自动适用本条款；维护者在商业使用前会另行取得授权。

不同意这些条款，请不要提交贡献。中英文版本含义不一致时，以英文版本为准。

## English

Use Node.js >=22.12 and pnpm 11.7.0; build and check with the commands above. Test in a disposable browser profile with synthetic bookmarks. Discuss major changes in an issue, keep PRs focused, describe validation, and update user docs and translations when behavior changes. Preserve the shared native mutation/confirmation/recovery boundary. Update privacy disclosures and dependency notices when adding network access or dependencies. Never commit credentials, personal bookmarks, private diagnostics or browser profiles. Follow the architecture, layout and agent instructions linked above. Contributions are subject to the contributor license grant below.

### Contributor license grant

From 23 October 2026, by submitting a contribution to this repository (including pull requests, patches, code, documentation, translations, images and other material), you agree to the following terms:

1. **You keep your copyright.** These terms do not assign copyright.
2. **The public license stays the same.** Once merged, your contribution is available to the public under [PolyForm Noncommercial 1.0.0](LICENSE).
3. **License to the maintainer.** You grant Astraxine and Astraxine's successors in interest a worldwide, perpetual, irrevocable, non-exclusive, royalty-free license to use, reproduce, modify, prepare derivative works of, publicly display, distribute and sublicense your contribution, including in commercial products and paid services and under terms other than PolyForm Noncommercial. This license is transferable.
4. **Patents.** For patent claims you own or control that are necessarily infringed by your contribution alone or by its combination with the project, you grant a license under those claims with the same scope as item 3.
5. **Your right to contribute.** You confirm that the contribution is your original work or that you otherwise have the right to submit it under these terms, including any permission required from your employer or other rights holders. If the contribution includes third-party code or material, state its source and license in the pull request.
6. **No obligation or warranty.** The maintainer is not required to use your contribution. Except as stated in item 5, it is provided "as is", without warranties of any kind.
7. **Earlier contributions.** Contributions submitted before 23 October 2026 are not covered automatically; the maintainer will obtain separate permission before using them commercially.

If you do not agree to these terms, do not submit a contribution. If the Chinese and English versions differ in meaning, the English version prevails.
