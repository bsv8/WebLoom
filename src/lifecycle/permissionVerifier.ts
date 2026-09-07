// 权限租约的最终边界验证器。
//
// Context 中的 permissions 只用于限制误用；RPC handler、最终存储写入或
// 签名提交处必须调用这里，不能信任请求体自带的 pluginId / owner / 世代。

import type {
  PermissionLease,
  PluginPermission,
} from "../contracts/lifecycle.js";

export interface VerifyPermissionLeaseOptions {
  /** 已由受信装配层创建的租约。 */
  lease: PermissionLease;
  /** 本次实际操作所需的最小权限。 */
  permission: PluginPermission;
  /** 从端口 / 当前会话权威取得的绑定值。 */
  binding?: Parameters<PermissionLease["assertBinding"]>[0];
}
/** 在最终 RPC / I/O 边界执行一次 fail-closed 校验。 */
export function verifyPermissionLease(options: VerifyPermissionLeaseOptions): void {
  options.lease.assert(options.permission);
  if (options.binding) options.lease.assertBinding(options.binding);
}
