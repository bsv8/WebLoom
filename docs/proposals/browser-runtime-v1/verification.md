# 浏览器双运行时 v1 验证记录

更新时间：2026-09-09

## 当前已通过

- WebLoom TypeScript typecheck：通过。
- Vitest：17 个测试文件、112 个测试通过；SharedWorker 的 Node 部分明确使用
  `MessageChannel` transport simulation。
- `pnpm lint:boundaries`：通过。
- `pnpm build`：通过。
- `pnpm run pack:consumer`：tarball、声明/source-map、core、React 和 Worker
  consumer smoke 通过。
- `git diff --check`：通过。

本轮还覆盖了 Window Host 的 `remoteRuntime` 投影、跨 Runtime 精确契约依赖、
断线后 blocked/reconnect reconcile、required 元数据防降级、显式 `unitId` 投影、
握手超时、SharedWorker 错误连接收敛，以及不可重连断线/dispose 后 `ready()`
持续拒绝。

## 真实浏览器证据

仓库新增 `scripts/browser-runtime-fixture/` 和 `pnpm run test:browser`。fixture
先由 Vite 生产构建，再从临时 dist preview 启动真实 HTML Window、module
SharedWorker 和两个页面，断言 Window/Worker realm marker、Worker setup 只执行
一次、共享 Worker 实例身份和独立 connectionId；同时覆盖真实重连、协议版本不兼容
和构建后 Worker URL。

当前执行结果：通过。仓库声明 Playwright 1.63.0，已安装 Chromium；runner 会在
每次验收前执行 `playwright install chromium`，缺少浏览器时仍 fail closed 为
`unsupported`/退出码 2，不回退为 Node 或同页面 MessageChannel。

## 下游迁移与发布边界

- DemoWebLoom 的九个课程已切换到 `definePlugin + createWindowApp`；07 remote
  使用 Vite 产出的真实 module SharedWorker。其独立仓库的 typecheck、production
  build 和真实 Chromium smoke 已通过，覆盖首页、九个课程路由、普通插件启停和
  07 的真实 Worker capability call。
- Keymaster Coordinator Worker 已把 `COORDINATOR_WORKER_UNIT_CATALOG` 的实际单元
  逐一装配为 `definePlugin`，由 `startSharedWorkerApp()` 管理；`worker.units` 和
  bootstrap snapshot 从 WebLoom Host 状态投影，旧 `CoordinatorWorkerUnitRegistry`
  只保留给领域句柄、任务和 final-I/O 清理使用，不再作为公开运行快照来源。Window
  client 通过 `connectSharedWorker()` 复用同一物理端口，保留原有 Coordinator RPC、
  私钥隔离、session epoch、owner fence、final-I/O lease 和 localStorage bridge。
  Keymaster typecheck、production build 以及 215-file Vitest batch 已通过。
- `webloom-framework@0.2.0` 仍是待发布工作区版本；npm registry 当前没有该版本，
  Keymaster 仍保留本地 `file:` 依赖，release-boundary 仍锁定已发布的 `0.1.0`。
  因此“npm 0.2.0 发布后重新安装并验收”的发布门禁尚未宣称通过，也没有在本轮
  伪造 registry 版本或自动发布。
