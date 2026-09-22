
# 智栏 · Markora

Chrome / Edge MV3 书签助手：浏览器原生书签是唯一事实源，AI 只产生经校验的数据，写入经唯一内核并留回执。

- [产品需求 PRD 1.0 + 1.1 增补](docs/PRD-1.0.md)：2026-09-22 起主流程为「浏览器原生收藏 → 后台自动分类 → 先写后告知」，第 15 节记录标废条款。
- [原生收藏自动分类任务树](.trellis/tasks/09-11-zhilan-native-ai-overhaul/prd.md)：R01–R18 与 P00–P08 子任务，尚在 planning。
- [首版 v1 任务树](.trellis/tasks/09-08-zhilan-v1-development/README.md)：12 个子任务源码基本完成，浏览器/真实模型/P1–P4 运行验收未做。
- [扩展工程说明](extension/README.md)：构建、检查、证据边界与各切片状态。
- [四风格交互原型](ui/prototype/README.md)、[隔离文件访问实验](experiments/file-access-probe/README.md)、[用户 P1 实测证据](.trellis/tasks/09-08-zhilan-technical-validation-design/research/p1-user-evidence-2026-09-08.md)。

## 当前状态（2026-09-22）

工作分支 `review/2026-09-22-design-fixes`。设计审查后的修复已提交：发布门最低 Chrome 114、循环导入与 schema 统一、操作日志 v2、导入映射按结构聚合、模型提示词层与分类策略、Prettier 格式化；宿主切换为工具栏 Popup + 选项页、恢复界面收窄、新鲜度改为版本号加任务依赖范围随后提交。规范见 `.trellis/spec/frontend/index.md` 的状态列。

运行时验收仍未执行：所有单元/集成测试是 jsdom 与真实 Vite 构建，不构成 Chrome/Edge 宿主、真实模型或用户书签数据的证据；`release:ready` 在人工门关闭前始终阻塞。
