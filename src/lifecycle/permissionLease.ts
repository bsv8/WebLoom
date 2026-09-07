// 绑定身份的权限租约实现。
//
// 申请权限、可信装配批准和当前作用域是三个独立条件。租约只授予它们的
// 交集；撤权后任何调用都 fail closed。这个模块不替代远端服务端校验，
// 后者必须在最终 RPC / I/O 或签名边界再次检查绑定字段。

import type {
  LifecycleScope,
  LifecycleScopeIdentity,
  PermissionLease,
  PermissionLeaseBinding,
  PermissionLeaseBindingExpectation,
  PluginPermission,
} from "../contracts/lifecycle.js";
import {
  PermissionDeniedError,
  PermissionLeaseRevokedError,
} from "../contracts/lifecycle.js";

export interface CreatePermissionLeaseOptions {
  /** 已由 Host 绑定的作用域身份；调用方不能从请求体自报。 */
  identity: LifecycleScopeIdentity;
  /** 插件 manifest 申请的权限。 */
  requested?: readonly PluginPermission[];
  /** 可信策略批准的权限。 */
  approved?: readonly PluginPermission[];
  /** 当前会话约束；存在时再与申请、批准求交集。 */
  sessionConstraints?: readonly PluginPermission[];
  /** 内置可信策略修订；策略变化后不能复用旧租约。 */
  policyRevision?: number;
  /** Connect 用户授权修订；内置插件可以省略。 */
  grantRevision?: number;
  /** Connect/外部授权的不可猜测授权标识；最终边界仍需查权威状态。 */
  grantId?: string;
  /** 可选作用域；撤权时自动撤销租约。 */
  scope?: LifecycleScope;
}

function uniquePermissions(permissions: readonly PluginPermission[] | undefined): PluginPermission[] {
  return [...new Set(permissions ?? [])];
}

function sameBindingValue(
  actual: string | number | undefined,
  expected: string | number | undefined
): boolean {
  return expected === undefined || actual === expected;
}

function sameAttributes(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (expected === undefined) return true;
  return Object.keys(expected).every((key) => Object.is(actual[key], expected[key]));
}

function normalizedRevision(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

/** 创建一个不可换绑的权限租约。 */
export function createPermissionLease(options: CreatePermissionLeaseOptions): PermissionLease {
  const binding: PermissionLeaseBinding = {
    ...options.identity,
    requested: Object.freeze(uniquePermissions(options.requested)),
    approved: Object.freeze(uniquePermissions(options.approved)),
    ...(options.sessionConstraints
      ? { sessionConstraints: Object.freeze(uniquePermissions(options.sessionConstraints)) }
      : {}),
    ...(options.policyRevision !== undefined
      ? { policyRevision: normalizedRevision(options.policyRevision, "policyRevision") }
      : {}),
    ...(options.grantRevision !== undefined
      ? { grantRevision: normalizedRevision(options.grantRevision, "grantRevision") }
      : {}),
    ...(options.grantId !== undefined
      ? { grantId: options.grantId }
      : {}),
  };
  Object.freeze(binding);
  const granted = new Set(
    binding.requested.filter((permission) =>
      binding.approved.includes(permission)
      && (binding.sessionConstraints === undefined || binding.sessionConstraints.includes(permission))
    )
  );
  let revoked = false;
  let revokeReason = "permission lease revoked";

  const lease: PermissionLease = {
    binding,
    get revoked() {
      return revoked || (options.scope !== undefined && options.scope.state !== "active");
    },
    has(permission) {
      return !lease.revoked && granted.has(permission);
    },
    assert(permission) {
      if (lease.revoked) {
        throw new PermissionLeaseRevokedError(revokeReason);
      }
      if (!granted.has(permission)) {
        throw new PermissionDeniedError(permission);
      }
    },
    assertBinding(expected: PermissionLeaseBindingExpectation) {
      if (
        !sameBindingValue(binding.pluginId, expected.pluginId)
        || !sameBindingValue(binding.instanceId, expected.instanceId)
        || !sameAttributes(binding.attributes, expected.attributes)
        || !sameBindingValue(binding.policyRevision, expected.policyRevision)
        || !sameBindingValue(binding.grantRevision, expected.grantRevision)
        || !sameBindingValue(binding.grantId, expected.grantId)
      ) {
        throw new PermissionLeaseRevokedError("Permission lease identity does not match");
      }
      if (lease.revoked) throw new PermissionLeaseRevokedError(revokeReason);
    },
    revoke(reason = "permission lease revoked") {
      if (revoked) return;
      revoked = true;
      revokeReason = reason;
    },
  };

  if (options.scope) {
    options.scope.onRevoke((reason) => lease.revoke(reason));
    options.scope.onDispose((reason) => lease.revoke(reason), "permission-lease");
  }
  return lease;
}
