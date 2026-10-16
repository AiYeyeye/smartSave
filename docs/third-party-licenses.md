# 第三方许可

智栏自有部分采用 [PolyForm Noncommercial 1.0.0](../LICENSE)。下列依赖仍适用其各自许可证，不受智栏非商业限制替代。

| 直接运行依赖 | 许可 |
| --- | --- |
| React、React DOM | MIT |
| eventsource-parser、jsonc-parser | MIT |
| mdast-util-from-markdown、parse5 | MIT |
| pinyin-pro、zod | MIT |
| lucide-react | ISC |

发行包包含 [THIRD_PARTY_NOTICES.txt](../extension/public/THIRD_PARTY_NOTICES.txt)，保留直接运行依赖及已列明传递依赖的声明。准确安装版本以 [pnpm-lock.yaml](../extension/pnpm-lock.yaml) 为准。`extension/licenses.json` 是依赖元数据快照，不是每个依赖完整授权文本，也不替代许可证复核。

构建工具另有 MIT、Apache、BSD、ISC、MPL 等许可。当前 lightningcss 的 MPL 条目属于构建工具元数据；若未来直接分发工具代码或修改其受保护文件，需另查对应义务。变更依赖时应重新生成清单并检查实际打包结果，不能将一次静态检查视为全量传递依赖合规证明。

商店图标复用项目现有 CSS 书签标识；演示截图使用本项目生产界面与虚构书签，没有使用 `ui/` 中的外部参考图。截图中的第三方名称仅说明演示内容，不表示第三方推荐或合作。
