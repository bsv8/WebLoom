# WebLoom v4 验证记录

更新时间：2026-09-11（工作树验证）。本记录只写已经执行的命令和观察到的结果；
未执行的跨浏览器、产品部署和 registry-only 验收不会由本地测试推断为通过。

用户已确认 `webloom-framework@0.4.0` 已发布。本轮按要求不重复发布，也不把发布条目
作为代码阻塞重新处理。

## 1. WebLoom 本仓库

以下本地门禁均通过：

- `pnpm test:types`：TypeScript 检查、`.typecheck.ts` 负向类型 fixture 和契约 inventory
  gate 通过；正式源码 inventory 为 1 个 capability identity。负向 fixture 覆盖错误
  request/response/item、local capability 跨 Runtime、错误 parser 和旧字符串获取。
- `pnpm test -- --reporter=dot`：17 个测试文件、106 个测试通过。
- `pnpm vitest run src/runtime/v4Acceptance.test.ts --reporter=verbose`：9 个 v4 acceptance
  测试通过，包括 AT-16。
- `pnpm build`：四入口 `index`、`advanced`、`react`、`testing` 的 ESM 与 declaration
  构建通过。
- `pnpm lint:boundaries`、`pnpm lint:v4`：通过。
- `pnpm run test:ablation`：AT-22 baseline 通过；删除 cancel、deadline、实例过滤、目录
  校验、revoke 五种机制后对应探针均按预期失败；恢复源码后再次通过。
- `pnpm run pack:consumer`：tarball gate、声明/source-map 检查，以及 core-only、advanced、
  React、Worker 四类独立 consumer 均通过。

### 真实 Chromium

`node scripts/real-browser-runtime-smoke.mjs` 使用 Vite production fixture 和真实
`SharedWorker` 通过。验证结果包括：

- 两个真实 Window 页面共享同一 `SharedWorkerGlobalScope`、同一 worker unit/setup，且每个
  peer 的 service exposure 独立；覆盖 reverse RPC、typed stream `[1,2,3]`、基础 buffer
  detach、重连后旧 proxy 撤销、terminal `stopping → disposed`、迟到连接和
  `protocol_mismatch`。
- `transfer-matrix` 通过 10 个场景：RPC request/result 的正常与重复 transfer、不可达
  request/result、stream request 与 item 的正常/重复/不可达 transfer、ready 前取消、发送
  后取消和发送前取消。
- 矩阵实际交付并回环验证 request/result/item 的业务 `MessagePort`，验证两个
  `Uint8Array` view 仍共享 backing buffer；不可达资源返回 `transfer_invalid`，发送前取消
  保留 buffer/port，发送后取消保持已转移状态。

真实浏览器版本：Chrome for Testing `153.0.8010.12`，Linux x64，headless。Firefox、真实
Safari 和 Playwright WebKit 本轮未执行，不能宣称兼容性已验收。

AT-16 的 `1/10/100 services × 1/2/10 peers` 测量在 `v4Acceptance.test.ts` 中执行：每次
广播只构建一个公共 base snapshot，wire 侧按 peer 投影 grant，且不重复公开 runtime 字段。

## 2. DemoWebLoom

以下门禁均通过：

- `pnpm build`：v4 boundary、`tsc --noEmit` 和 Vite production build 通过，九章入口及
  real SharedWorker chunk 均生成。
- `node scripts/real-browser-smoke.mjs`：index、01–09 九章、01 插件 disable/enable、
  07 两页真实 SharedWorker call 均通过；验证共享 worker/runtime/unit identity 与逐 peer
  service identity。

Demo 的验证使用当前本地 WebLoom 工作树链接；这证明源码类型和真实浏览器交互，不替代
registry-only frozen install。用户已确认 0.4.0 已发布，本轮不重复执行发布闭环。

## 3. Keymaster

以下本地代码门禁均通过：

- `pnpm test:types`：`tsc -b` 与 Keymaster contract inventory gate 通过，inventory 为
  75 个 identity；Coordinator response/result 负向类型 fixture 通过编译保护。
- `pnpm test`：216 个测试文件全部通过（18 个常规批次加 2 个重型隔离批次）；其中
  Coordinator worker 113 tests、Vault service 79 tests 均通过。
- `pnpm build`：Vite production build 通过，3982 个 module transformed；生产产物扫描
  通过（13 个 HTML/JS/CSS 文件）。
- `pnpm lint:boundaries`：storage hard-switch、plugin boundary 和 Coordinator final-I/O
  审计均通过。
- `git diff --check`：通过。

上述 Keymaster type/test/build 证据使用本地依赖树。Local/S3 真实浏览器、CORS/CAS、重启、
多 tab、恢复、app-view 外部环境和公开部署仍需产品环境证据；单元测试通过不等价于这些
验收已经关闭。

## 4. 发布与 registry 边界

按用户提供的当前外部状态，`webloom-framework@0.4.0` 已发布；本轮不再运行 npm publish、
registry release checker 或 registry-only frozen install，也不修改下游 lockfile 来伪造
registry integrity。若日后需要重新审计，应从 registry 读取真实 `dist.integrity`，再单独
执行三仓 frozen-install 消费验证。

## 5. 尚未关闭的跨环境验收

- Firefox、真实 Safari、Playwright WebKit 的 module SharedWorker、双向 transfer 和 stream
  组合尚未执行。
- Keymaster 的 app-view、Local/S3/CORS/CAS、重启/多 tab、恢复 ledger、不可逆 I/O 和部署
  生产门禁没有本轮完整外部证据。

因此当前结论是：本轮四类 review 代码阻塞已完成修复，WebLoom/Demo 的本地与 Chromium
证据已补齐，0.4.0 发布条目按用户指示忽略；跨浏览器与 Keymaster 产品/部署验收仍保持
明确的未验收状态。
