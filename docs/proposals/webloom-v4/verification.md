# WebLoom v4 验证记录

更新时间：2026-09-11（工作树验证）。本记录只写已经执行的命令和观察到的结果；
未执行的 registry、产品部署和跨浏览器验收不会由本地测试推断为通过。

## 1. WebLoom 本仓库

以下门禁均通过：

- `pnpm test:types`：TypeScript 检查与契约 inventory gate 通过；当前 inventory 为 1 个
  capability identity。
- `pnpm test`：17 个测试文件、105 个测试通过。
- `pnpm build`：四入口 `index`、`advanced`、`react`、`testing` 的 ESM 与 declaration
  构建通过。
- `pnpm lint:boundaries`、`pnpm lint:v4`：通过。
- `node scripts/real-browser-runtime-smoke.mjs`：通过。生产构建实际发出
  `assets/worker-C8NPoyKw.js` 与 protocol-mismatch fixture；Chromium 读取到
  `SharedWorkerGlobalScope`；覆盖双页共享
  Worker/runtime/unit、逐 peer 的 service identity、typed stream `[1,2,3]`、transfer
  detach、reconnect 后旧 proxy revoke、terminal `stopping → disposed`、dispose 后迟到
  连接和 protocol mismatch。
- `pnpm run pack:consumer`：通过。tarball 文件清单和体积上限检查、声明/source-map 检查，
  以及 core-only、advanced、React、Worker 四类独立 consumer 均通过。

候选包的具体 `npm pack` metadata 和 `dist.integrity` 只写入下游 lockfile 和发布核对记录，
不嵌入本文件；本文件本身属于发布包，修改其中的完整性字符串会再次改变 tarball 内容。

真实浏览器版本：Chrome for Testing `153.0.8010.12`，Linux x64，headless。Firefox、真实 Safari
和 Playwright WebKit 本轮未执行，不能宣称兼容性已验收。

## 2. DemoWebLoom

以下门禁均通过：

- `./node_modules/.bin/tsc --noEmit`：通过。验证时使用当前 WebLoom 工作树的本地
  `node_modules` 链接；这只证明源码类型兼容，不替代 registry/frozen-install。
- `node scripts/check-v4-boundary.mjs`：通过。
- `node scripts/real-browser-smoke.mjs`：通过。生产构建覆盖首页、01–09 九章、01
  插件 disable/enable、07 两页真实 SharedWorker call；07 验证共享 Worker/runtime/unit
  identity 与逐 peer service identity。

Demo lockfile 已与上述本地候选的 `0.4.0` integrity 对齐；浏览器 smoke 使用当前本地
安装树构建，证明真实 realm 与交互，不替代 registry/frozen-install 证据。

## 3. Keymaster

以下本地代码门禁通过：

- `./node_modules/.bin/tsc -b`：通过。
- 直接调用已安装的 `vitest`，按仓库 12-file batch 计划执行：216 个测试文件全部通过；
  其中 Coordinator worker 113 tests、Vault service 79 tests 均单独通过。
- `git diff --check`：通过。
- `node scripts/check-boundaries.mjs`、`node scripts/check-react-resource-boundaries.mjs`、
  `node scripts/check-coordinator-final-io-audit.mjs`：均通过。

Keymaster 的 `pnpm typecheck` 在 workspace 依赖自检阶段尝试从 registry 获取
`webloom-framework@0.4.0` 并返回 404；因此 canonical pnpm workspace 验证仍未关闭。
在本地已有依赖树上直接运行 Vitest 与 `tsc -b` 只作为代码/测试证据，不能替代
frozen install。

Keymaster 与 Demo 的包声明、workspace release exception 和 lockfile 已切到精确 `0.4.0`。
lockfile 记录的是上述已测候选 tarball，最终发布前必须由 registry 的真实 `dist.integrity`
替换/确认。

## 4. Registry 与发布边界

本轮执行结果为明确未通过（外部状态阻塞）：

- `npm view webloom-framework version dist.integrity versions --json` 返回当前 registry
  版本 `0.3.0`，版本列表只有 `0.1.0`、`0.2.0`、`0.3.0`。
- `node scripts/check-webloom-release-boundary.mjs` fail-closed：
  `webloom-framework@0.4.0` 不存在于 `https://registry.npmjs.org/`。
- `node scripts/check-webloom-registry-consumer.mjs` fail-closed：registry-only 临时消费
  目录返回 npm `ETARGET`，不能安装 `webloom-framework@0.4.0`。

因此当前结论是“源码与本地 tarball/Chromium 验收完成，`0.4.0` registry 发布、registry
integrity 核对和 frozen downstream install 尚未完成”。不执行自动 npm publish，也不把
本地 tarball 或 workspace symlink 当作公开发布证据。

## 5. 尚未关闭的产品验收

Keymaster 的外部 app-view、不可逆 I/O、恢复/部署生产门禁，以及 Local/S3 的真实浏览器、
CORS、CAS、重启/多 tab 和公开服务验收，本轮没有取得完整外部环境证据；这些项目仍保持
未验收状态。已有 Coordinator/恢复单元测试通过，不等价于上述产品/部署验收。
