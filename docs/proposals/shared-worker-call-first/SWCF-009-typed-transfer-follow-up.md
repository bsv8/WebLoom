# SWCF-009 typed capability/transfer 后续施工单

## 状态与版本边界

本施工单从 `webloom-framework@0.3.0` 的 call-first 迁移中正式拆出，目标后续
版本（暂定 `0.4.0`）。因此 0.3.0 保留 `connectSharedWorker()` 的
`onConnection` 和 `startSharedWorkerApp()` 的 `onPortConnect` 作为 Keymaster
迁移接缝，但不得把这两个接缝描述成最终公共架构。

0.3.0 的已完成范围是 Runtime v2、惰性 ServiceBridge、call/result/error/cancel
传输、完整快照、Provider/revocation fence、Demo 和 Keymaster 的 v2 service wire。
0.3.0 不宣称 SWCF-009 或 npm registry 发布完成。

## 后续不变量

- capability method 必须声明 request transferables 和 result transferables；未声明的
  capability 只能走 structured clone。
- transfer list 由 capability 适配器产生，调用方不得取得裸 Runtime `MessagePort`，也
  不得用 `any` 或全局消息监听绕过 capability 边界。
- request/result 的 transferable 所有权、取消、deadline、dispose、Worker 重启和
  late-result fence 都必须有类型级和真实浏览器测试。
- Keymaster Coordinator 的主请求、事件和 Local `localStorage` page bridge 必须迁入
  typed API；owner/session/grant/handover/final-I/O fence 与 `UpgradeGate.handshake`
  必须保持原顺序和语义。

## 收口门禁

1. 先实现并导出 typed request/result transfer descriptor 和测试入口。
2. 迁移 Keymaster Coordinator 的所有主 RPC、事件及 transferable 操作；保留领域
   `connectionId` 仅在其自身协议中使用。
3. 通过真实浏览器双 Tab、断线/重启、lock/unlock、A → B → A、Local bridge、迟到
   result 和安全 fence 回归。
4. 从生产入口删除 `onConnection`、`onPortConnect`；把 worker factory 保持在 testing
   入口，并重新执行三仓 typecheck、build、pack/registry consumer 和发布验收。
