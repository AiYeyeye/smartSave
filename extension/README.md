# Historical extension source / 历史扩展源码

See the [branch overview](../README.md). This branch preserves its earlier implementation. Read this branch's package.json for dependency/runtime requirements and scripts. Public builds require no private agent/task directories.

本分支保留早期实现；依赖版本与命令以本分支 package.json 为准。公开构建不依赖私有任务或代理配置。

```sh
pnpm --dir extension install --frozen-lockfile
pnpm --dir extension lint
pnpm --dir extension typecheck
pnpm --dir extension test
pnpm --dir extension test:integration
pnpm --dir extension build
pnpm --dir extension release:source
```

Run integration tests before the final production build. Native bookmarks remain authoritative; preserve mutation, confirmation and recovery boundaries. Source tests do not satisfy the manual release gates. Keep private data in ignored `.local/private/`; use only synthetic public fixtures.
