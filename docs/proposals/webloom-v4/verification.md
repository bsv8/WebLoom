# WebLoom v4 验证记录

更新时间：2026-09-11（工作树验证）。本记录只写已经执行的命令和观察到的结果；
未执行的跨浏览器、产品部署和 registry-only 验收不会由本地测试推断为通过。

`webloom-framework@0.4.1` 已发布到 npm。本轮发布的是同一 v4 wire 的 patch 版本；registry
返回的 `dist.integrity` 为
`sha512-/sXro/by2FDq6ZehsOUnuYT8JwaaK3o6bn0uN/ZhtQBWd/7dlTbVcxZF+BlGJ/4dAhqhNOlUWXyGJ5Vk77IOLw==`。

## 1. WebLoom 本仓库

以下本地门禁均通过：

- `pnpm test:types`：TypeScript 检查、`.typecheck.ts` 负向类型 fixture、契约 inventory
  gate 和临时 Git 基线回归自测均通过；正式源码 inventory 为 1 个 capability identity。
  负向 fixture 覆盖错误 request/response/item、local capability 跨 Runtime、错误 parser
  和旧字符串获取。基线自测验证“源码与 inventory 同时进入新 HEAD、但
  `contractTestVersion` 未变”会在显式旧 commit 基线下失败。
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

### Contract inventory 基线策略

本地 `node scripts/check-contract-inventory.mjs` 保持以当前 `HEAD` 作为默认基线，便于
检查未提交工作树。提交级 CI 应执行 `pnpm run test:contract-inventory:ci`：它优先使用
`CONTRACT_INVENTORY_BASELINE_REF` 或 GitHub Actions 的 `GITHUB_BASE_SHA`，否则使用
`git merge-base HEAD origin/main`，最终显式传入 `--baseline-ref <sha>`。该门禁不会把
包含新源码和新 inventory 的当前提交当作自己的历史基线。

## 2. DemoWebLoom

以下门禁均通过：

- `pnpm build`：v4 boundary、`tsc --noEmit` 和 Vite production build 通过，九章入口及
  real SharedWorker chunk 均生成。
- `node scripts/real-browser-smoke.mjs`：index、01–09 九章、01 插件 disable/enable、
  07 两页真实 SharedWorker call 均通过；验证共享 worker/runtime/unit identity 与逐 peer
  service identity。

Demo 的验证使用当前本地 WebLoom 工作树链接；这证明源码类型和真实浏览器交互，不替代
registry-only frozen install。Demo 已切换到 `0.4.1` 并在 frozen install 后完成类型、生产
构建和真实 Chromium smoke；Keymaster 的 registry-only 四入口 consumer 也已从 npm
`0.4.1` 验证通过。

## 3. Keymaster

以下本地代码门禁均通过：

- `pnpm test:types`：`tsc -b`、Keymaster contract inventory gate 和临时 Git 基线回归自测
  通过，inventory 为 75 个 identity；Coordinator response/result 负向类型 fixture 通过
  编译保护。
- `pnpm test`：216 个测试文件全部通过（18 个常规批次加 2 个重型隔离批次）；其中
  Coordinator worker 113 tests、Vault service 79 tests 均通过。
- `pnpm build`：Vite production build 通过，3982 个 module transformed；生产产物扫描
  通过（13 个 HTML/JS/CSS 文件）。
- `pnpm lint:boundaries`：storage hard-switch、plugin boundary 和 Coordinator final-I/O
  审计均通过。
- `git diff --check`：通过。

另外，在提交 `1edc117` 的 detached 临时 checkout 中执行
`pnpm install --frozen-lockfile --ignore-scripts && pnpm test:types && pnpm test`：安装
成功，`test:types` 通过，随后 216 个测试文件（18 个常规批次加 2 个重型隔离批次）全部
通过。该 fresh-install 结果也覆盖了 `@keymaster/plugin-token-bsv21` 对
`@noble/secp256k1` 的直接声明，以及根测试 setup 对 `@noble/secp256k1` 和
`@noble/hashes` 的直接声明。

Local/S3 真实浏览器、CORS/CAS、重启、多 tab、恢复、app-view 外部环境和公开部署仍需
产品环境证据；单元测试和 fresh-install 通过不等价于这些验收已经关闭。

## 4. 发布与 registry 边界

上一轮已实际完成 `webloom-framework@0.4.0` 的 registry integrity、Keymaster/Demo
lockfile 一致性、release-boundary 和 registry-only consumer 验证；该版本是本轮的已发布
基线。本轮已发布 `webloom-framework@0.4.1`，并从 registry 读取上述真实 `dist.integrity`。
Keymaster 与 Demo 的 package 声明和 lockfile 均已切换到该版本；Keymaster
`pnpm lint:webloom-release`、`pnpm verify:webloom-registry` 以及两仓 frozen-install 验证
均通过，不能用本地 tarball 代替这些证据。

## 5. Contract inventory CI

WebLoom 和 Keymaster 均新增 `.github/workflows/contract-inventory.yml`。workflow 使用
`actions/checkout` 的 `fetch-depth: 0`；PR 显式映射
`github.event.pull_request.base.sha`，main push 映射 `github.event.before`，然后执行
`pnpm test:types` 和 `pnpm run test:contract-inventory:ci`。job 名称固定为
`contract-inventory`，可作为仓库 required status check。

workflow 文件已落地并已在本地用显式历史 baseline 验证脚本通过；GitHub branch protection
中将 `contract-inventory` 设为 required 的远端仓库设置，本轮无法从当前失效的 GitHub
认证态读取或修改，因此该设置仍需在仓库管理面确认。

## 6. 尚未关闭的跨环境验收

- Firefox、真实 Safari、Playwright WebKit 的 module SharedWorker、双向 transfer 和 stream
  组合尚未执行。
- Keymaster 的 app-view、Local/S3/CORS/CAS、重启/多 tab、恢复 ledger、不可逆 I/O 和部署
  生产门禁没有本轮完整外部证据。

因此当前结论是：核心代码修复、`0.4.1` 下游版本一致性、registry consumer 和 inventory
workflow 已完成；GitHub required-check 远端设置仍待确认。跨浏览器与 Keymaster 产品/部署
验收仍保持明确的未验收状态。

<a id="pcb-verification"></a>

## 7. 插件实例消费边界迭代（PCB-001–PCB-006）

本节是 [施工单第 8 节](./implementation-plan.md#pcb-plan) 的独立验证记录，只覆盖本轮
WebLoom 单仓改动。上面的 v4 历史记录不作为本轮完成证据；下游仓库、外部环境与发布
动作本轮未执行，也不因此被推断为通过。

### 7.1 基线（PCB-001）

| 项目 | 值 |
| --- | --- |
| 实施基线 HEAD | `ae7a24e` 发布 WebLoom 0.5.0：完善流式字节配额与并发控制 |
| 包版本 | `webloom-framework@0.5.0`（本轮未升版本、未发布） |
| Node | `v24.21.0` |
| pnpm | `11.5.1` |
| 工作树 | 实施前已存在未提交的 PCB 源码与脚本改动，全部保留并在其上增量完成 |

基线最小事实（由本轮回归固定）：普通 `ctx` 读取未声明能力被 `resolveCapability` 拒绝；
App 读取不带插件身份；实例资源 loader 走 `getCapability(id)` 字符串入口与 store 全局
resolver，不核对所属单元声明。本轮把资源读取改为实例视图 + owner 绑定的 typed 解析，并
新增 consumer 受限视图；App 读取按需求保留为可信装配层接口，没有改写它的语义。

本轮新增依赖：`vite@7.3.6`（devDependency，真实浏览器 fixture 的生产构建与 preview），
并新增 `pnpm-workspace.yaml` 记录 `allowBuilds.esbuild`，否则 `pnpm install` 会因 esbuild
构建脚本未批准而失败。lockfile 已同步。

### 7.2 实际执行的命令

以下命令均在上述工作树执行，日志未另存文件时以终端输出为准。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test -- --reporter=dot` | 21 个测试文件、194 个测试通过 |
| `pnpm lint:boundaries` | 通过 |
| `pnpm lint:v4` | 通过 |
| `pnpm test:types`（含契约 inventory 与基线自测） | 通过，正式源码 inventory 为 1 个 capability identity |
| `pnpm build` | 四入口 `index`/`advanced`/`react`/`testing` 的 ESM 与 declaration 构建通过 |
| `pnpm run test:ablation` | 通过；5 个机制消融后对应测试均按预期失败，恢复后通过 |
| `node scripts/real-browser-runtime-smoke.mjs` | 通过，见 7.4 |
| `pnpm run pack:consumer` | 通过，见 7.5 |

基线失败修正：`test:ablation` 在本轮开始时已失败（HEAD 0.5.0 的
`scripts/check-v4-ablation.mjs` 仍在变异旧版 `validateMessage` 签名，在
`src/runtime/runtimeProtocol.ts` 找不到目标字符串）。该失败属于既有基线而非本轮引入，
已把消融目标更新为当前“跳过快照校验”的等价位置，5 个机制重新全部按预期失败。

### 7.3 运行时与负面断言（PCB-002–PCB-005）

`src/host/pluginConsumer.test.ts`（24 个用例）与
`src/react/pluginConsumerBindings.test.tsx`（11 个用例，jsdom）覆盖：

- `ctx.consumer` 与 `ContributionAdapterInput.consumer` 是同一对象；身份取自 Host 真实
  实例，不采信注册项自填字段。
- 未声明能力、错版本能力在 `capability()` 与 `optionalCapability()` 两条路径都拒绝；
  已声明但缺席的 optional 返回 undefined 且可重复读取。
- 每次解析都核对提供方当前可用性：停用后 `capability()` 立刻失败、`optionalCapability()`
  返回 undefined；重启后取到第二代服务而不是旧引用。React 侧对应
  `useOptionalPluginCapability`/`useHasPluginCapability` 同步反映缺席与恢复。
- 撤权后旧 consumer 立即拒绝；同名重启签发新的 `instanceId` 与 consumer，旧视图不复活；
  撤权后旧 setup ctx 的 `capability/optionalCapability` 同样失败。
- 可用期间重复读取同一契约返回同一引用（React 快照需要），但该稳定性不跳过可用性判定。
- 结构复制、`{...consumer}`、JSON 往返都没有框架签发身份，Provider 与来源检查都拒绝。
- 异步贡献注册期间实例被撤销时，适配器返回的句柄被立即回收：对象句柄的 `revoke` 与
  `dispose` 都执行（函数句柄按 `revoke` 处理），旧实例不留可挂载入口；迟到的 `dispose`
  拒绝不会变成未处理 rejection，也不会让 Host 生命周期失败。
- 已取得的远程 RPC client 与 stream 订阅在撤权后调用失败，不退回根 scope。
- 资源：`register` 的 owner 由 Host 绑定；跨实例注销、伪造 unowned/他人 owner 被拒绝；
  等价重新定义的注册表契约（相同 kind/id/version）同样被包装，拿不到裸注册表；自定义
  注册表不支持 owner 绑定时直接抛错而不是落成宿主资源；key/load/subscribe 三个阶段都校验
  owner，撤权后取消在途加载、不发布迟到数据、注销定义；旧实例的 owner 条件注销不会误删
  同名新实例的同名定义；插件资源不借用宿主同名能力；资源上下文按 `optional` 参数走可选或
  必需路径（已声明但缺席返回 undefined 且资源进入 ready，未声明仍然拒绝并进入 error）；
  宿主 unowned 资源走装配层 resolver 且按 kind/version 匹配。
- React：缺少插件 Provider 报错且不回退 App Provider；插件子树内 `useWebLoomApp`、
  App capability hook、管理 hook 全部拒绝；撤权后 Provider 停止渲染旧子树；同名重启用
  新 consumer；共享 Picker 在提供方上下文运行，消费方父组件不获得提供方权限；无关变化
  不触发额外渲染；StrictMode 重挂载无重复订阅。
- 跨插件资源读取：提供方把全局 store 封装成只含 `read`/`subscribe` 的 typed 能力，消费方
  声明依赖即可读取与订阅；能力面上没有 `invalidate`、注册表或 owner 查询，框架没有新增
  资源授权 wire，也没有按资源 id 前缀自动授权。

`src/contracts/consumer.typecheck.ts` 与 `pack:consumer` 的类型 fixture 覆盖类型负面：
字符串 id、数字、未声明契约、管理成员（`provide/handle/enable/disable/dispose/host/app/
rootScope`）、插件侧的 `ResourceContext.getCapability` 都不能通过编译。每一处
`@ts-expect-error` 的作用是让删除该行后编译确实失败。

### 7.4 真实 Chromium（PCB-R08）

`node scripts/real-browser-runtime-smoke.mjs` 使用 Vite 生产构建（76 modules，两个 HTML
入口：`index.html` 与 `plugin-consumer.html`）和真实 SharedWorker 通过。
浏览器：Google Chrome for Testing `153.0.8010.12`，Linux x64，headless。

插件消费边界页面（`window.__WEBLOOM_PCB_RESULT__`）实际结果：

```json
{
  "ok": true,
  "dynamicTheme": "dark",
  "optionalState": "absent:false",
  "homeTheme": "home:dark",
  "sharedPicker": "picker-open",
  "ownerConsistent": true,
  "secretRejected": true,
  "forgedRejected": true,
  "appHookRejected": true,
  "undeclaredRegistryRejected": true,
  "sneakedAbsent": true,
  "beforeDisable": "dark",
  "afterDisable": null,
  "revokedRejected": true,
  "newInstance": true,
  "stillRevoked": true,
  "afterRestart": "dark",
  "pickerRevoked": true,
  "profileData": "owner-scoped-profile",
  "profileAfterRevoke": false
}
```

覆盖施工单要求的三种场景：动态页面注册、静态首页贡献、提供方共享 Picker；以及未声明
能力、伪造 consumer、插件子树内 App hook、未声明内置资源注册表四类负面断言，撤权后旧
子树停止渲染、同名重启为新实例、owner 撤权后资源不降级为宿主资源。

本轮修复的两个真实缺陷（均由该页面暴露）：

1. fixture 只有 `index.html` 一个构建入口，`plugin-consumer.html` 从未进入生产产物，
   浏览器拿到 404 而验收并未执行。已新增 `scripts/browser-runtime-fixture/vite.config.mjs`
   显式声明两个入口。
2. fixture 的页面插件调用 `ctx.capability(RESOURCE_REGISTRY)` 却没有声明该依赖；框架按
   声明检查拒绝（正确行为），但可选插件的 setup 失败会被记录为状态而不是抛错，导致资源
   断言以“定义不存在”结束。已在 fixture 中补上显式依赖，并新增“未声明注册表既读不到
   也不能留下资源定义”的负面断言。

另外修复浏览器 runner 的两个既有缺陷，都会让 `pnpm run test:browser` 无法可靠结束：

- `vite preview` 子进程与 playwright 传输层留下的 pipe 句柄让脚本打印完结果后不退出；
  现在显式收尾并在 flush stdout 后以退出码结束。
- `pnpm exec` 派生的 vite 孙进程不随包装进程被杀，端口一直被占用，下一次运行会以
  `Port 4178 is already in use` 失败；现在 preview 以独立进程组启动并按组终止。

连续两次执行 `node scripts/real-browser-runtime-smoke.mjs` 均返回 0，结束后端口释放且
无残留进程。

Firefox、真实 Safari 与 Playwright WebKit 本轮未执行，不能宣称兼容性已验收。

### 7.5 发布包消费者（PCB-006）

`pnpm run pack:consumer` 通过：tarball 白名单、必需文件、`.d.ts`/`.js.map` 本地路径检查，
以及 core-only、core-only 运行时装载（PluginConsumer 读取、重复读取引用稳定、撤权后旧
视图永久失效、同名重启签发新 consumer）、advanced（实例资源按 owner 解析 typed 能力，
撤权后不降级为宿主资源）、React（Provider 与三个插件 hook 的公开面、内部 context 不外泄、
运行时渲染与撤权、伪造 consumer 被拒绝）、Worker 四类独立消费者均通过。core-only 消费
项目不安装 React。

`contract-inventory.json` 已更新：`src/contracts/resource.ts` 只改动了公开 TypeScript 面
（`ResourceContext` 的 typed 入口），capability 的 kind/id/version 与 parser/transfer 字段
不变，wire 版本保持 `1`；`contractTestVersion` 升到 `webloom-v4-contract-tests.4` 并记录
等价性证据。

### 7.6 评审轮次修复（同一轮内的复核发现）

首轮自查之后又做了一次复核，复核发现 5 个绕过路径；它们都属于本轮范围（PCB-002/003/
004/005），不是新需求。全部已修复，并各自补了“修复前必然失败”的回归：

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | 等价契约（相同 kind/id/version 重新 `defineCapability`）绕过注册表实例包装，拿到裸注册表 | 内置注册表按 `capabilityKey` 契约身份判断包装，不再用对象引用相等；资源解析同样按身份 | `pluginConsumer.test.ts` “等价重新定义的资源注册表契约同样被包装” |
| 2 | consumer 缓存跳过提供方可用性：停用后仍返回第一代服务，重启后仍指向第一代 | 删除 consumer 侧缓存，每次解析走共享 resolver；引用稳定性改由 resolver 保证（同 realm 客户端按契约身份缓存，bridge 客户端只在代理撤销后换对象） | `pluginConsumer.test.ts` “consumer 每次解析都核对提供方可用性”、`pluginConsumerBindings.test.tsx` “提供方停用后 optional/has 立即反映缺席” |
| 3 | 旧 setup ctx 在撤权后仍能取能力（有效性检查只在 consumer 外层） | 实例有效性检查移入共享 resolver 第一行，ctx/consumer/资源解析共用同一条约束 | `pluginConsumer.test.ts` “撤权后旧 setup ctx 不能再取能力” |
| 4 | 资源可选依赖被当必需依赖解析，缺席时资源进入 error | 资源能力解析按 `optional` 参数走 `optionalCapability` 或 `capability` | `pluginConsumer.test.ts` “资源上下文按 optional 解析” |
| 5 | 迟到贡献只执行 `revoke`、漏掉 `dispose` | 迟到句柄走完整收尾（`revoke` + `dispose`），dispose 拒绝按现有同步路径处理，不产生未处理 rejection | `pluginConsumer.test.ts` “异步贡献注册期间实例被撤销”与“迟到贡献的 dispose 失败不阻断 revoke” |

修复后的完整门禁结果见 7.2；单元测试从 187 增至 194 个用例，全部通过。

### 7.7 本轮未覆盖

- 下游仓库（Keymaster / DemoWebLoom）的接入改动未实施；仅提供
  [`docs/plugin-consumer-migration.md`](../../plugin-consumer-migration.md) 接入说明。
- 未升版本、未发布 npm、未修改任何下游锁文件或部署配置。
- local capability 返回的普通对象/函数的撤销不在本轮范围，已在 API 文档写明限度，未按
  任意代码隔离宣传。
- 跨浏览器（Firefox / 真实 Safari / Playwright WebKit）与产品环境验收仍未关闭。


<a id="psm-verification"></a>

## 8. 插件服务模型迭代（PSM-001–PSM-008）

本节是 [施工单第 8 节](./implementation-plan.md#plugin-service-plan) 的独立验证记录。
第 7 节只证明上一波实例消费边界在其当时的检查范围内成立，不证明本轮的服务模型、私有
UI、资源私有性或“无用户启停”已经完成。下游改动、外部环境与发布本轮均未执行。

### 8.1 基线（PSM-001）

| 项目 | 值 |
| --- | --- |
| 实施基线 HEAD | `ae7a24e` 发布 WebLoom 0.5.0：完善流式字节配额与并发控制 |
| 起始版本 → 本轮版本 | `0.5.0` → `0.6.0`（破坏性；未发布） |
| Node / pnpm | `v24.21.0` / `11.5.1` |
| 工作树 | 保留上一波全部未提交修改，在其上增量实施 |

删除清单（源码位置）：`PluginManifest.startup/defaultEnabled/canDisable` 与
`PluginStartupMode`（`src/contracts/plugin.ts`）、`PluginIntentCommand/Snapshot/Controller/
Coordinator/SubmissionResult/CommandResult`（`src/contracts/lifecycle.ts`）、
`src/lifecycle/pluginIntentController.ts` 整个模块、`PluginConfigStore` /
`createInMemoryPluginConfigStore` / `initialPluginConfig` / `pluginIntentCoordinator`
（Host options）、`host.enable/disable/suspend/submitIntent`、`StartupPluginError`、
`usePluginRuntime().enable/disable/submitIntent/isEnabled`、
`PluginState.desiredEnabled/desiredRevision`、`PluginUnitState.desiredRevision`、
`PluginReverseDep.enabled`（改为 `running`）、`PluginStateKind` 的 `disabled`/
`error-disabled`（新增 `failed`）。

### 8.2 实际执行的命令

| 命令 | 结果 |
| --- | --- |
| `pnpm test:types` | 通过；契约 inventory 1 个 identity，基线自测通过 |
| `pnpm test -- --reporter=dot` | 23 个测试文件、220 个测试通过 |
| `pnpm lint:boundaries` / `pnpm lint:v4` | 通过；`lint:v4` 新增“已删除启停表面不得回归”规则 |
| `pnpm build` | 四入口 `index`/`advanced`/`react`/`testing` 构建通过 |
| `pnpm run test:ablation` | 通过；5 个机制消融后对应测试均按预期失败 |
| `pnpm run pack:consumer` | 通过，见 8.6 |
| `node scripts/real-browser-runtime-smoke.mjs` | 通过，见 8.5 |

### 8.3 生命周期回归（PSM-002 / PSM-003）

`src/host/pluginLifecycle.test.ts`（10 个用例）用事件轨迹断言顺序，而不是只看最终状态：

- 打乱登记顺序（A → B → C 登记）仍按 C → B → A 启动；
- 释放根提供者后按 A → B → C 清理，消费者先于提供者释放；
- 清理是异步的（每个插件 5ms）：断言 `dispose-start/end` 严格交替，证明没有用
  `Promise.all(plan)` 并发清理；Host 整体销毁同样按反向依赖顺序，而不是登记顺序倒序；
- 共享提供者不因单个消费者被释放而销毁；
- **已绑定的可选依赖参与启动排序**：消费者先登记、提供者在清单中时，仍然先启动提供者
  （`start:provider` → `start:consumer`，读到 `bound`）；没有提供者的可选依赖不产生等待；
- 可选依赖缺席不等待，出现后被绑定，失效只降级消费者；
- 提供者初始化失败进入 `failed` 并保留原因，恢复后按正向顺序重建，且不重放副作用；
- 依赖环与提供者歧义在装配阶段被拒绝；
- `PluginState` 不含 `desiredEnabled` / `desiredRevision`。

`src/host/pluginConsumer.test.ts` 与 `src/react/pluginConsumerBindings.test.tsx` 中的
旧“停用/重新启用”用例已改为真实实例撤销/重建事件（`revoke` + `retry`），并保留旧句柄、
迟到注册与迟到结果失效断言。

行为变化已记录在 `docs/plugin-service-migration.md`：`createWindowApp()` /
`startSharedWorkerApp()` 不再因单个插件启动失败而 reject，改为 `blocked` / `failed` 状态
加 `blockedBy` / `explain()` 原因；装配阶段的依赖环、歧义与非法契约仍直接拒绝。

### 8.4 私有实现与注册服务回归（PSM-R04 / PSM-R05 / PSM-R07）

- `src/lifecycle/scopedRegistry.test.ts`（10 个用例）：归属由 Scope 身份写入、传入他人
  实例被拒绝、只能注销本实例条目、撤销后条目同步撤下且迟到注册被拒、旧实例清理不会
  删掉同名新实例条目、非插件实例 scope 不能作为归属来源、签发信息可核对；**更新只允许
  作用于本实例条目且不能改写归属字段**（伪造他人实例抛错，正确值也从补丁中剥离）；
  **异步注册在撤销之后完成时立即回收**，不会留下失效条目，也不会删掉同名新实例的条目。
- `src/react/pluginConsumerBindings.test.tsx`（13 个用例）：私有实现只经私有 Context
  读取（无 Provider 时读不到）、私有实现没有公开 descriptor、网页注册服务必须声明依赖
  才能读取（`capability` / `optionalCapability` / `useHasPluginCapability` 三条路径都拒绝）。
- `src/resources/instanceResourceRegistry.ts`：`get()` / `_ids()` 现在只返回本实例定义，
  并在实例撤销后拒绝；插件上下文仍不暴露全局 `ResourceStore`。
- `src/runtime/psmBoundary.test.ts`（5 个用例）：内部 RPC 服务不自动成为外部服务、
  名单之外与私有实现都无法经模拟网关解析、可信会话不接受调用参数覆盖；消费者远程句柄
  撤销后失效；local 副作用服务的保证限度（已取得的普通对象不被撤销，但新解析已失效）；
  **旧 RPC/stream 句柄绑定解析当下的服务实例世代**：可选提供者释放并重建后，旧句柄以
  `service_stale` / `service_revoked` 失败，不会自动改用第二代实现；重新解析才得到绑定
  新世代的句柄（同世代重复解析仍返回同一引用，React 快照不受影响）。

### 8.5 真实 Chromium（PSM-R08 / PSM-R10）

`node scripts/real-browser-runtime-smoke.mjs` 使用 Vite 生产构建（两个 HTML 入口）和真实
SharedWorker 通过。浏览器：Google Chrome for Testing `153.0.8010.12`，Linux x64，headless。

插件消费边界页面（`window.__WEBLOOM_PCB_RESULT__`）实际结果：

```json
{
  "ok": true,
  "storagePage": "page:bucket-a/contacts=v1",
  "storageSettings": "settings:bucket-a",
  "storageHeader": "header:bucket-a",
  "webUiKinds": ["page", "settings", "header", "page", "settings", "header"],
  "ownerBound": true,
  "entriesAfterRevoke": 0,
  "storageUiAfterRevoke": "page:bucket-b/contacts=v1",
  "privateUnreachable": true,
  "crossOwnerRejected": true,
  "forgedRejected": true,
  "appHookRejected": true,
  "undeclaredRegistryRejected": true,
  "sneakedAbsent": true,
  "beforeDisable": "dark",
  "afterDisable": null,
  "revokedRejected": true,
  "newInstance": true,
  "stillRevoked": true,
  "afterRestart": "dark",
  "pickerRevoked": true,
  "profileData": "owner-scoped-profile",
  "profileAfterRevoke": false
}
```

网页插件挂载了两个假 Storage 实例注册的页面/设置块/指示灯共 6 个条目
（`webUiKinds`），每个组件读取的是自己所属实例的私有 Context；条目 owner 由框架按实例
身份写入（`ownerBound`）；撤销其中一个实例后它的 3 个条目被撤下（`entriesAfterRevoke` 为
0），另一个实例的 UI 仍正常渲染（`storageUiAfterRevoke` 仍是 bucket-b）。负面断言：私有
实现无公开解析入口、跨实例注销被拒、伪造 consumer 被拒、插件子树内 App hook 被拒、未声明
内置资源注册表既读不到也不能留下资源定义。

本轮修复的 fixture 问题：私有 Context 的子组件必须作为元素进入 Provider 子树，直接调用
会在 Provider 建立上下文之前执行（`storagePage` 曾为 `page:no-private`）。

### 8.6 发布包消费者（PSM-R07）

`pnpm run pack:consumer` 通过：core-only、advanced、React、Worker 四类独立消费者全部通过，
core-only 不安装 React。新增断言：

- 类型层面：`manifest.startup/defaultEnabled/canDisable`、`host.enable/disable/submitIntent`、
  `PluginState.desiredEnabled` 均不能通过编译（每处 `@ts-expect-error` 删除后编译失败）。
- 运行时：Host 上不存在 `enable/disable/submitIntent/suspend`，`host.state()` 不含
  `desiredEnabled`，实例释放与恢复走 `revoke` / `retry`。

契约清单已更新：`webloom.resource.registry` 身份不变（local、无 parser/transfer、版本 1），
仅依赖指纹 `src/contracts/lifecycle.ts` 随启停契约删除而变化，`contractTestVersion` 升到
`webloom-v4-contract-tests.5` 并记录等价性证据。快照单位状态枚举的变化由
`src/runtime/runtimeProtocol.ts` 的同一份列表在两端校验。

本地 tarball（未发布、未上传）：

| 项目 | 值 |
| --- | --- |
| 文件 | `webloom-framework-0.6.0.tgz` |
| `dist.integrity` | `sha512-DLourInWEkE9lWpcEElCgYDg54hK9UUs2Stc/WrEvaZGgIaHT/ERafSOsHBjv+8os9VE/etNgyKd8jsuMXbnaQ==` |
| `shasum` | `d26a4e7daf841800195567962335a4ca36284472` |

该产物只用于 pack consumer 验证；registry 状态、真实下发与下游 frozen install 仍未执行。

### 8.7 本轮未覆盖

- 下游仓库（Keymaster / DemoWebLoom）未做任何修改；仅交付
  [`docs/plugin-service-migration.md`](../../plugin-service-migration.md) 与
  [`docs/plugin-consumer-migration.md`](../../plugin-consumer-migration.md)。
- 未发布、未上传、未修改任何下游锁文件或部署配置；旧 Worker 与线上会话的接管不在本轮。
- 同一 realm 的 local 副作用服务不做深层撤销（文档已写明限度），最终 I/O 授权仍由领域
  authority 复核。
- Firefox、真实 Safari 与 Playwright WebKit 未执行，不能宣称跨浏览器已验收。
- 产品级 import 门禁（禁止跨插件私有实现导入、裸单例与全局 Host 注入）由下游源码门禁
  负责；WebLoom 只提供入口约束，不声称能在同一 realm 拦截任意 JavaScript。

### 8.8 复核轮次修复（同一轮内的第二次复核）

第一轮验收后再次复核，发现 5 处顺序/归属/世代缺口；它们都属于已声明要求（PSM-003、
PSM-004、PSM-006），不是新需求。全部已修复，并各自补了“修复前必然失败”的回归：

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | 销毁用 `Promise.all` 并发清理，消费者未清理完提供者就释放；Host 销毁按登记顺序倒序 | 新增 `teardownLayers()`，先同步围栏整条计划，再按销毁层级分层等待；同层并行 | `pluginLifecycle.test.ts` “消费者清理完成后才释放提供者”“Host 整体销毁同样按反向依赖顺序” |
| 2 | 已绑定的可选依赖不参与排序，消费者先登记会先启动并读到缺席 | `startupLayers()` 同时使用 `dependencies` 与 `optionalDependencies`，只有已确定提供者的可选依赖产生边 | `pluginLifecycle.test.ts` “已绑定的可选依赖参与启动排序” |
| 3 | UI 注册门面的 `update` 直接透传，可跨实例修改他人条目 | 新增更新规则（`updateIdArgument` / `immutableProperties`）：只允许更新本实例条目，归属字段不可改写（伪造他人实例抛错，正确值被剥离） | `scopedRegistry.test.ts` “更新只能作用于本实例条目，且不能改写归属字段” |
| 4 | 异步注册在撤销之后完成会留下失效条目 | 注册返回 Promise 时登记 `pendingRegistration`：撤销/清理等待它结束，并在完成回调里复核 scope，已撤销且条目仍属本实例时立即回收；归属已被新实例接管时不动 | `scopedRegistry.test.ts` “异步注册在撤销之后完成时，条目不会残留”“异步注册晚到不会删掉同名新实例的条目” |
| 5 | 旧 RPC/stream 句柄会自动调用新实例 | 同 realm 客户端绑定解析当下的 `serviceInstanceId`，调用/订阅时复核世代（`service_stale` / `service_revoked`）；实例内缓存键加入世代，提供者重建后签发新句柄 | `psmBoundary.test.ts` “可选提供者重建后旧 RPC 句柄永久失效”“可选提供者重建后旧 stream 句柄同样失效” |

修复后的完整门禁结果见 8.2；单元测试从 212 增至 220 个用例。真实 Chromium 与发布包
消费者在修复后重跑，均通过（见 8.5、8.6）。


### 8.9 复核阻断项关闭（REVIEW-01–04）

本轮先关闭实施计划 8.11 列出的 4 项复核阻断问题，再实施 PSM-009–011。四项都属于已声明
要求，不是新需求：

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| REVIEW-01 | `pluginGraph.reverse` 只含必需依赖，整体销毁时可选提供者可能先于消费者释放 | 新增 `orderingReverse`（含已绑定的可选边）专供 `teardownLayers()`；`reverse` 仍是仅必需依赖的撤销级联 | `pluginLifecycle.test.ts` “整体销毁时消费者也先于它的可选提供者清理”“可选提供者撤销只让消费者降级” |
| REVIEW-02 | 旧门面的 `update`/`unregister` 只查历史登记，同名条目被新实例接管后仍可改写 | owner 记录升级为 `{ instanceId, generation }`，每次写操作与清理复核当前 owner 与注册世代 | `scopedRegistry.test.ts` “同名条目被新实例接管后旧门面不能更新或删除” |
| REVIEW-03 | 旧异步注册晚到会覆盖底层 Map 中的新条目 | 新增 `ScopedRegistryCommitter` / `view.stage()`：实际写入阶段复核 scope 与当前 owner，撤销或被接管时 `commit()` 返回 `false` 且不写入 | `scopedRegistry.test.ts` “旧异步提交晚到不会覆盖新 owner 与新内容” |
| REVIEW-04 | 同 realm 在途 RPC/stream 只绑定消费者取消信号 | 本地服务绑定 `serviceInstanceId` 与在途工作集合；提供者撤销即取消在途调用/流并拒绝迟到结果 | `psmBoundary.test.ts` “可选提供者撤销时在途 RPC 失败”“可选提供者撤销时在途 stream 不会发布迟到结果” |

### 8.10 完整插件与多 Worker 槽位（PSM-009–PSM-011，本轮部分完成）

实现要点：

- `definePluginPackage()` 接收真实 `definePlugin` 单元，按 runtime 合并为**一份** manifest；
  `implementationsForRuntime()` 供各 realm 只装配属于自己的单元（Worker 不加载 Web 实现，
  页面不加载 Worker 实现，无函数源码传输）。
- 单元新增 `privateProvides` 与 `ctx.handlePrivate()` / `ctx.privateCapability()` /
  `consumer.privateCapability()`。私有服务带 `private` 标记进入 Runtime 快照（跨 realm 才
  连得上），但公共解析路径、`host.optionalCapability()` 与 Connect 自动导出名单一律拿不到；
  授权键取 Host 记录的真实 `pluginId + unitId`，跨 realm 共享 pluginId 不是凭据。
- Window Host 由单 `capabilityBridge` 改为 `bridges: Map<slotId, bridge>`；
  `attachRemote()` 返回连接世代，`detachRemote()` 传入旧世代时是空操作，因此延迟卸载不会
  误伤同槽位后来替换上的新连接。
- 真实浏览器 fixture `multi-worker.html`：一个 Window 同时连接 Storage 与 Vault 两个真实
  SharedWorker，覆盖顺序无关（先连 Vault）、并存、单边断开（Storage 回到 `blocked`、
  Vault 继续工作）、同槽换新连接、旧连接延迟卸载后连接仍在、所属私有跨单元调用返回
  `private:a.txt,b.txt`，以及外部插件三条私有路径全被拒。

本轮门禁（全部通过）：

| 门禁 | 结果 |
| --- | --- |
| `pnpm exec tsc -p tsconfig.json --noEmit` | 通过 |
| `pnpm exec vitest run` | 24 个文件、235 个用例通过 |
| `pnpm run test:types`（含契约清单） | 通过 |
| `pnpm run lint:v4` 与 v4 边界检查 | 通过 |
| `pnpm run build` | 通过 |
| `pnpm run test:ablation` | 通过 |
| `pnpm run pack:consumer` | 通过（core-only、advanced、React、Worker 四类消费者） |
| `node scripts/real-browser-runtime-smoke.mjs` | 通过（含新增 multi-worker 页面） |

### 8.11 复核第二轮：5 项计划内阻断的关闭

REVIEW-01–04 关闭后，同一批复核在新实现里又复现了 5 项阻断项。全部已修复，每项都有
"修复前必然失败"的回归：

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | 普通 `RuntimeHandle.capability()` 能取得并执行私有函数：客户端过滤 `private` 不构成授权 | 私有调用必须携带装配层签发的票据（`definePrivateCapability({ grantId })` → `RpcCallOptions.grantId` → wire `grantId`）；接收端在 `handleCall` 里、执行 handler **之前**核对票据，缺失或不匹配一律 `permission_denied` | `pluginPackage.test.ts` "1 未授权调用方拿不到私有函数：handler 不执行"（无票据、伪造票据、正确票据三种）；浏览器 `multi-worker.html` 的 `unauthorizedCall === "permission_denied"` |
| 2 | 本地私有旧句柄只在获取时检查有效性，返回的函数直接调用 handler | 私有客户端改为复用已验证的 RPC/stream 客户端机制（绑定 `serviceInstanceId`、每次调用复核世代、提供者撤销取消在途并拒绝迟到结果）；同时把私有登记纳入撤销回收，撤销后必须重新解析 | `pluginPackage.test.ts` "私有句柄绑定提供者世代：提供者重建后必须重新解析"、复核回归 "2 …在途调用被取消" |
| 3 | 错误槽位能满足必需依赖：就绪判断扫描全部 bridge | 就绪判断与能力解析读同一份绑定表（`unitSlotBindings`），并复用 `endpointFor`（默认排除 `attributes.private` 的服务），绑定槽位不存在时其他槽位的同名服务不算满足 | `pluginPackage.test.ts` "3 绑定槽位不存在时，其他槽位发布同名服务也不能满足必需依赖" |
| 4 | 远端就绪不会自动恢复等待单元，浏览器 fixture 的手动轮询掩盖了它 | `attachRemote` 订阅 bridge 目录变化并驱动统一 reconcile；替换与卸载时清理订阅。fixture 改为注册后不再调用任何 reconcile，直接观察自动收敛 | `pluginPackage.test.ts` "4 远端目录发布后自动驱动依赖收敛"；浏览器 `storageAutoConverged` / `vaultAutoConverged` |
| 5 | 完整插件包身份没有贯穿装配入口：`implementationsForRuntime` 返回原单元 manifest | 装配入口返回**完整包 manifest**（只含该 realm 的单元），插件身份恒为包 id；定义阶段直接拒绝不属于该包的单元 | `pluginPackage.test.ts` "5 完整包身份贯穿装配入口，并在定义阶段拒绝不一致单元" |

本轮门禁：`tsc --noEmit`、`vitest run`（24 文件、242 用例）、`test:types`、`lint:v4`、
`build`、`test:ablation`、`pack:consumer`、真实浏览器 smoke 全部通过。
`contractTestVersion` 升到 `webloom-v4-contract-tests.6`：`src/contracts/capability.ts` 的
`RpcCallOptions.grantId` 是调用方票据字段，不改变 `webloom.resource.registry` 的身份、parser
或 wire 形态。

### 8.12 复核第三轮：4 项计划内阻断的关闭

第二轮复核又在私有通信与槽位收敛上复现了 4 项阻断项，全部已修复：

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | 反向私有调用（Worker → Window）没有授权检查，`connectSharedWorker` 的提供端直接执行 handler | 两端接收路径共用同一个授权检查（`privateCallAuthorized`），RPC 与 stream 都在执行 handler 之前核对票据 | `pluginPackage.test.ts` "1 反向私有调用（Worker → Window）没有票据同样被拒：handler 不执行" |
| 2 | 票据只比对契约对应的静态字符串：关掉原连接后，另一连接重放同一票据仍可调用 | 票据改为**连接绑定**派生值 `derivePrivateGrant(机密, connectionId)`：调用侧用自己这条连接推导，接收侧用**入站调用的** connectionId 重新推导后常数时间比对。换连接、重连或其他连接重放一律失败；实例撤销时票据随之失效 | `pluginPackage.test.ts` "2 票据绑定连接：另一连接重放同一票据失败"；第一轮用例 "1 未授权调用方拿不到私有函数" 增加跨连接重放断言 |
| 3 | 显式卸载槽位时先取消订阅再使 bridge 失效，目录通知无法驱动收敛，消费者停在 `enabled` | `attachRemote`（替换）与 `detachRemote`（卸载）在完成失效后显式请求统一收敛 | `pluginPackage.test.ts` "3 显式卸载槽位后消费者回到等待" |
| 4 | `externalRuntimeDependencies: true` 时 `missingDependencies` 直接视远端依赖已满足，没有连接也启动 | 该选项只放宽静态装配校验（`validatePluginGraph`）；运行时就绪只由真实端点或同 Host 提供者满足 | `pluginPackage.test.ts` "4 externalRuntimeDependencies 不能替代运行时就绪检查" |

本轮门禁：`tsc --noEmit`、`vitest run`（24 文件、246 用例）、`test:types`、`lint:v4`、
`build`、`test:ablation`、`pack:consumer`、真实浏览器 smoke 全部通过。

### 8.13 复核第四轮：4 项计划内阻断的关闭

第三轮复核把私有授权从"静态字符串"升级为"装配机密 + 实例授权记录"，并修正依赖就绪判断：

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | 消费实例撤销后旧票据仍可调用：票据只绑定机密与连接 | 装配层**配置**（静态机密）与**实例授权记录**（`{secret, instanceId}`，启动签发、撤销回收、重建重签）分离；票据带实例分量；私有客户端每次调用前复核本实例记录，撤销后旧句柄在发出请求前即被拒 | `pluginPackage.test.ts` "2 消费实例撤销后旧票据失效，重建后新票据可用" |
| 2 | 撤销只清理 `privateProvides[0]` 对应授权；纯消费单元不清理；`retry()` 后授权丢失导致合法私有接口无法再解析 | 撤销按实例回收该单元**全部**授权记录；实例启动统一依据配置重新签发，重建后自动恢复 | 同上（撤销 → 失败，重建 → 恢复） |
| 3 | 接收端 `privateGrantFor()` 按契约取第一条机密，两个获准单元登记不同机密时第二个合法调用被拒 | 接收端改为 `privateGrantSecrets()`（该契约的全部登记机密）+ `privateGrantInstanceIds()`（对端快照中该契约被授权且仍存活的实例），逐一匹配命中项，不依赖登记顺序，也不信任调用者自填身份 | `pluginPackage.test.ts` "2 票据绑定连接与消费实例：换连接或换实例都失效" |
| 4 | `missingDependencies()` 先用本地 `capabilities.has()` 判定满足，本地同名服务可顶替"声明来自 Worker/绑定槽位"的依赖 | 就绪判断先确定声明来源与绑定槽位：声明远端来源或存在绑定槽位时，只由该槽位上真实发布的服务满足（私有服务不算）；本地提供者只在没有远端来源时生效 | `pluginPackage.test.ts` "4 本地同名服务不能顶替声明来自 Worker 的依赖" |

已知边界（诚实记录）：接收端能逐实例核对，前提是**调用侧会向该 realm 发布单元快照**（例如
页面通过 `client: { app, expose }` 或 Host 对 peer 发布快照）。没有发布时接收端只能核对连接
分量；此时实例撤销由调用侧授权记录拦截（旧句柄发不出请求），但"同一连接上重放已泄露票据"
的边界是这条连接本身，不是实例。

本轮门禁：`tsc --noEmit`、`vitest run`（24 文件、248 用例）、`test:types`、`lint:v4`、
`build`、`test:ablation`、`pack:consumer`、真实浏览器 smoke 全部通过。
`contractTestVersion` 升到 `webloom-v4-contract-tests.7`（`CapabilityBridge.remoteUnits()` 只读投影 +
`RpcCallOptions.grantId`，均不改变 `webloom.resource.registry` 的身份与 wire 形态）。

### 8.14 复核第五轮：3 项计划内阻断的关闭

第四轮把私有授权升级为实例绑定，但仍有三处绕过或不一致，已全部修复：

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | 空快照让已失效票据重新生效：接收端用 `remoteUnits.length > 0` 决定是否核对实例，为空就降级成只校验连接 | 取消降级：私有调用必须命中一条「机密 + 存活实例」的可信记录，没有可授权实例（例如空快照）一律 `permission_denied` | `pluginPackage.test.ts` "1b 空快照不会让已失效票据重新生效"（注销后连续两次调用都失败）；浏览器 `unauthorizedCall === "permission_denied"` |
| 2 | 机密与所属实例未一一绑定：把"全部机密"与"全部存活实例"交叉匹配，A 单元机密配 B 单元实例也能通过 | 接收端改为候选记录 `{pluginId, unitId, secret, instanceId}`：候选由「装配配置匹配对端快照里的同一单元」生成，只按同一条记录核对，不做交叉匹配 | `pluginPackage.test.ts` "2 票据绑定连接与消费实例：换连接或换实例都失效"（含跨单元交叉匹配断言） |
| 3 | 就绪遵守槽位但实际调用可能走本地：resolver 只看 `sourceRuntime`，本地与 Worker 同契约时调用落到本地 | resolver 与 `missingDependencies` 共用同一来源规则：声明远端来源**或**存在绑定槽位时只能走该槽位；声明同 realm 却绑定远端槽位属于声明冲突，直接拒绝 | `pluginPackage.test.ts` "4b 就绪遵守槽位时，实际调用也必须走该槽位"（本地 handler 从未执行）、"4c 声明同 realm 却绑定远端槽位时明确拒绝" |

连带改动：浏览器 fixture 改为先建 Host/App、连接时带 `client: { app }`，让页面把单元实例
快照发布给 Worker——接收端要核对"消费实例仍然活着"就必须能看到这份快照；空快照此时表示
没有可授权实例，而不是退化为连接级校验。

本轮门禁：`tsc --noEmit`、`vitest run`（24 文件、251 用例）、`test:types`、`lint:v4`、
`build`、`test:ablation`、`pack:consumer`、真实浏览器 smoke 全部通过。

### 8.15 复核第六轮：2 项计划内阻断 + 一处回归证据纠正

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | 异步授权期间撤销消费实例，handler 仍会执行：私有实例检查发生在 `await policy.authorize()` 之前，等待结束后只复核提供者/连接/信号 | 私有调用的在途工作绑定"消费实例授权有效期"：等待期间订阅对端目录变化，实例从快照消失即中止合并信号；等待结束后再复核同一实例，撤销/失效应 `permission_denied`，迟到结果不发布（handler 收到的 `context.signal` 也是这个合并信号） | `pluginPackage.test.ts` "1c 授权等待期间撤销消费实例：在途请求不得执行 handler" |
| 2 | 声明与槽位冲突仍允许消费者提前启动：resolver 拒绝冲突，但 `missingDependencies()` 把槽位服务算作满足 | 就绪判断先做冲突判定（声明同 realm 却绑定远端槽位 → 依赖不满足），与解析给出同一结论，消费者不会先跑起来再在解析时失败 | `pluginPackage.test.ts` "4c 声明同 realm 却绑定远端槽位时：消费者不启动，解析也拒绝" |

**回归证据纠正**：上一轮登记的 "1b 空快照不会让已失效票据重新生效" 与实际不符——它调用的是
`revokeCaller()` 后走已撤销的客户端，既没有注销最后一个消费单元，也没有直接重放旧票据。已按
复核要求重写为：正常调用一次 → 取调用实例身份与票据 → 撤销消费单元并等待页面快照中该实例消失
（空快照）→ **用客户端句柄直接重放撤销前的旧票据两次** → 两次都必须 `permission_denied`，handler
只执行过一次。

本轮门禁：`tsc --noEmit`、`vitest run`（24 文件、252 用例）、`test:types`、`lint:v4`、
`build`、`test:ablation`、`pack:consumer`、真实浏览器 smoke 全部通过。

### 8.16 复核第七轮：3 项 RPC/stream 生命周期缺陷 + 两处回归证据纠正

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | RPC 迟到结果仍会发布：handler 只收到合并信号，返回后没有复核授权 | 结果发布前再复核同一授权实例（`assertPrivateResultPublishable`），已撤销直接拒绝；两端接收路径都接入 | `pluginPackage.test.ts` "1d handler 忽略取消并返回时，撤销后的迟到结果不会被发布"（handler 执行一次且返回 `{ok:true}`，客户端拿不到结果） |
| 2 | 合法私有 stream 的票据被丢掉：`snapshotStreamOptions()` 没有复制 `grantId` | 冻结 stream 选项时保留授权字段 | `pluginPackage.test.ts` "3a 合法私有 stream 订阅成功（票据不被丢弃）" |
| 3 | stream 授权订阅过早清理：handler 返回 AsyncIterable 后 `finally` 就释放，撤销后后续 item 仍到达 | 授权绑定持续到流结束或取消（`guardPrivateStream`）：每次取下一项前复核，失效即停止并调用 iterator `return()`；释放交给流结束路径。Window 接收端（`connectSharedWorker`）执行同一规则 | `pluginPackage.test.ts` "3b 消费实例撤销后私有 stream 不再交付后续 item"、"1c 授权有效期规则：撤销后既拒绝迟到结果，也截断后续 item" |

**回归证据纠正**：
- `1c` 原实现的 `configurePeer` 是空函数，没有真正挂起授权。已替换为两条正式回归：`1c`
  （规则层：发布前复核抛错 + 流在撤销后结束）与 `1c2`（跨 realm 集成：异步授权等待期间撤销
  消费者 → 放行授权 → handler 不执行）。
- `1b` 已改为**注销**页面 Host（最后一个消费单元消失 → 页面不再发布单元快照），随后直接重放
  注销前的旧票据两次，两次都 `permission_denied`。

本轮门禁：`tsc --noEmit`、`vitest run`（24 文件、253 用例）、`test:types`、`lint:v4`、
`build`、`test:ablation`、`pack:consumer`、真实浏览器 smoke 全部通过。

### 8.17 复核第八轮：stream 异步清理阻断 + 动态暴露定性纠正

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | stream 在异步清理完成前就报告结束并释放授权资源：`stop()` 先 `finish()` 再后台调用 `return()`，provider 随后按自然结束处理，绕过"等待 iterator 清理后释放执行名额" | 关闭改为**幂等的共享 Promise**：停止、取消与重复 `return()` 复用同一次清理；清理完成前不报 `done`、不释放授权资源，占用保持到清理结束 | `pluginPackage.test.ts` "3c 异步清理完成前不得把流报告成结束、也不得释放授权资源"（清理未完成时 `settled=false`、`release` 未被调用；重复 `return()` 只触发一次清理） |

**动态暴露定性纠正**：上一轮把"`configurePeer → peer.expose()` 不发布到对端快照"记为框架缺陷，
该定性不成立。正确装配为：先 `await worker.ready()`、配置 `peerExposureAllowlist`、同一能力只通过
`configurePeer` 暴露（不同时放入顶层 `expose`）。按此装配，"异步授权等待 → 撤销消费者 → 放行授权
→ handler 不执行"的跨 realm 集成回归 `1c2` 通过。因此该条从未是框架缺陷，撤回上一轮的定性。

本轮门禁：`tsc --noEmit`、`vitest run`（24 文件、254 用例）、`test:types`、`lint:v4`、
`build`、`test:ablation`、`pack:consumer`、真实浏览器 smoke 全部通过。

### 8.18 复核第九轮：清理产出泄漏 + 缺失回归补齐

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | `closeIterator()` 原样返回底层 `return()` 的结果：生成器在 `finally` 里 `yield` 时会交付清理产出，并在后续 `next()` 重复返回 | 关闭路径在内部消费并丢弃清理产出，直到真正结束才返回 `done:true`；仍复用同一个关闭 Promise，释放仍发生在清理完成之后 | `pluginPackage.test.ts` "3d 清理阶段产出的 item 必须被丢弃，不得交付或重复返回" |

**回归缺失的纠正**：上一轮登记的 `3c`（以及 `3a`/`3b`）在测试源码中并不存在——只有规则层的
`1c` 与集成回归 `1c2` 落地。现已补齐，并**按覆盖层次准确标注**：

- 真实 transport（Worker + 页面连接）：`3a` 合法私有 stream 订阅成功（票据未被丢弃）；
  `3b` 消费实例撤销后不再交付后续 item。
- 直接针对包装器（`guardPrivateStream`，不经过 transport）：`1c` 发布前复核与流截断规则、
  `3c` 异步清理闸门（清理未完成不报告结束、不释放授权资源；重复 `return()` 只触发一次清理）、
  `3d` 清理阶段产出被丢弃、`3e` 清理产出超过 64 项仍全部消费完、`3f` bounded drain 超时
  保留未完成语义。

本轮门禁：`tsc --noEmit`、`vitest run`（24 文件、258 用例）、`test:types`、`lint:v4`、
`build`、`test:ablation`、`pack:consumer`、真实浏览器 smoke 全部通过。

### 8.19 复核第十轮：关闭循环的次数上限阻断

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | 关闭循环用 `guard++ > 64` 截断清理产出，达到上限后仍返回 `done:true` 并释放授权资源：只处理 66 项、底层 `finally` 未跑完就报告结束并释放占用 | 删除次数上限，改为**时间预算**的 bounded drain：一直消费到底层真正结束；预算耗尽时不报告自然结束、不释放资源，保留未完成状态与执行占用并如实抛错 | `pluginPackage.test.ts` "3e 清理阶段产出超过 64 项：全部消费完才报告结束并释放"（100 项全消费、`finallyFinished=true`）、"3f 清理未在预算内结束：不报告自然结束、不释放资源（保留未完成语义）" |

本轮门禁：`tsc --noEmit`、`vitest run`（24 文件、260 用例）、`test:types`、`lint:v4`、
`build`、`test:ablation`、`pack:consumer`、真实浏览器 smoke 全部通过。

### 8.20 复核第十一轮：bounded drain 覆盖异步等待 + 执行名额占用

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | 时间预算没覆盖异步等待：截止时间在 `await return()` 之后才设置，且只在两次 `next()` 之间检查；挂起的 `return()`/`next()` 不会被预算打断 | 预算**从关闭开始计时**，并用定时器与底层真实完成竞速，因此挂起的 `return()` 与挂起的 `next()` 都能被预算打断 | `pluginPackage.test.ts` "3f 清理未在预算内结束：不报告自然结束、不释放资源；迟到完成后再回收"（清理挂起 → 20ms 预算 reject） |
| 2 | 超时后 transport 实际释放了执行名额：provider 把 `return()` 的拒绝当作清理完成，`executionCount()` 从 1 掉到 0 | 明确区分「用户可见超时」与「底层真实完成」：provider 侧 `return()` 拒绝或同步抛出不再标记 `returnDone`，改为 `cleanupIncomplete` 并保持名额占用，迟到完成（watcher 观察到底层 iterator 结束）才回收 | `messagePortServiceProvider.test.ts` "keeps the execution slot when iterator cleanup is incomplete and reclaims it on late completion"（清理挂起期间 `executionCount()===1`，放行后降到 0） |

包装器侧同步区分两层：用户可见的关闭 Promise 受预算约束（超时即 reject，不报告自然结束），
底层真实完成的 Promise 不受打断，结束时才释放授权资源并通过 `onLateCompletion` 通知 provider
回收执行名额。

本轮门禁：`tsc --noEmit`、`vitest run`（24 文件、261 用例）、`test:types`、`lint:v4`、
`build`、`test:ablation`、`pack:consumer`、真实浏览器 smoke 全部通过。

### 8.21 复核第十二轮：provider 不再用 `next()` 推断清理完成

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | 两层之间推断清理完成：包装器在关闭超时后让 `next()` 立即返回 `done:true`，provider watcher 把它当成底层清理完成并释放执行名额（实测 `cleanupFinished=false` 而 `executionCount()===0`） | 包装器把「底层清理真实完成」通过 `PRIVATE_STREAM_CLEANUP_SIGNAL` 暴露；provider 只订阅这个可信信号，**不再调用 `next()` 推断**。没有可信信号的普通 iterator 保持占用，由 runtime drain 如实报告未完成执行数 | `messagePortServiceProvider.test.ts` "wrapper + provider: cleanup budget expiry keeps the execution slot until the real cleanup settles"（预算耗尽且底层清理未完成时 `executionCount()===1`；迟到完成后降到 0） |

上一轮的普通生成器回归仍保留（挂起清理期间名额为 1，放行后为 0），本轮补上的是**包装器超时
拒绝路径 + 真实 provider 的联测**，正是此前缺失的组合。

本轮门禁：`tsc --noEmit`、`vitest run`（24 文件、262 用例）、`test:types`、`lint:v4`、
`build`、`test:ablation`、`pack:consumer`、真实浏览器 smoke 全部通过。

### 8.22 复核第十三轮：清理循环饿死事件循环

| 编号 | 问题 | 修复 | 回归位置 |
| --- | --- | --- | --- |
| 1 | 后台清理循环连续等待立即完成的 `next()`，不让出事件循环：清理阶段若持续 `yield`，预算定时器/取消/其他请求都得不到运行（复核用 `finally { for(;;) yield "cleanup" }` + 10ms 预算复现，5 秒仍未超时） | 清理循环按批次让出事件循环（`PRIVATE_STREAM_DRAIN_YIELD_INTERVAL = 32`）。批次**只用于调度**，不作为"清理完成"判据；预算与占用语义不变 | `pluginPackage.test.ts` "3h 清理阶段持续快速产出：预算定时器仍能触发，清理未完成不释放资源"（预算 10ms 内 reject、期间排队的宏任务已执行、`finallyFinished=false` 且 `release` 未调用、收尾后释放一次） |

本轮门禁：`tsc --noEmit`、`vitest run`（24 文件、263 用例）、`test:types`、`lint:v4`、
`build`、`test:ablation`、`pack:consumer`、真实浏览器 smoke 全部通过。

PSM-011 仍未覆盖（本轮范围不再扩大）：一个 Web 单元内的页面/设置/header 三类 UI、两个 Window 共用
一个 Worker、共享 Worker 与分离 Worker 两种装配的同模块对比、私有入口的类型层面负面用例、
迁移指南更新。因此不能称"完整插件与多 Worker"已验收完成，Keymaster 迁移也未开始。

源码变化后重新打包的本地产物（未发布、未上传）：

| 项目 | 值 |
| --- | --- |
| 文件 | `webloom-framework-0.6.0.tgz` |
| `dist.integrity` | `sha512-R7RbqOBi9KhDQThK3OpcGtoDJOHPp6DZ8DMNzgqbATIoVG/6HfknsEcc0j+baVAxdOnh/avQdxKWlggaCzUWWg==` |
| `shasum` | `cd669f36c1ff5abc39596e60c500ac3732a345d7` |

（第二轮复核修复后重新打包；上一条 8.10 里的 integrity 对应修复前的源码，已失效。）
