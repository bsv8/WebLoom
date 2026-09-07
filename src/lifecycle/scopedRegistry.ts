// 把已有 Registry 绑定到插件实例作用域。
//
// 该 facade 不改变 Registry 的业务类型，只在注册方法周围登记所有权：
// 资源创建成功后立刻绑定 instance scope，停止时按 after-teardown 阶段
// 注销。setup 前后 snapshot 仍保留作旧插件兼容兜底，但新注册不依赖它。

import type { LifecycleScope } from "../contracts/lifecycle.js";

export interface ScopedRegistryRegistration {
  /** 注册方法名，例如 register / registerFeature。 */
  method: string;
  /** 从参数哪个位置读取带 id 的定义。 */
  idArgument?: number;
  /** 没有返回取消函数时使用的注销方法。 */
  unregisterMethod?: string;
  /** 注销方法的参数位置；默认使用 idArgument。 */
  unregisterArgument?: number;
  /** 含 ownerPluginId 参数的注册方法；由 Host 绑定当前插件身份。 */
  bindPluginIdArgument?: number;
  /** 定义对象中的 ownerPluginId 字段；存在时必须与当前插件一致。 */
  ownerPluginIdProperty?: string;
}

export interface CreateScopedRegistryFacadeOptions {
  /** 日志和作用域资源中显示的注册表名。 */
  name: string;
  /** 注册方法规则；缺省只包装 register(item)。 */
  registrations?: readonly ScopedRegistryRegistration[];
}

type AnyFunction = (...args: any[]) => any;
type RegistryTarget = Record<PropertyKey, any>;

function definitionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function defaultRegistrationRules(): ScopedRegistryRegistration[] {
  return [{ method: "register", idArgument: 0, unregisterMethod: "unregister" }];
}

/** 创建一个只对当前插件实例开放的 Registry 视图。 */
export function createScopedRegistryFacade<T extends object>(
  target: T,
  scope: LifecycleScope,
  options: CreateScopedRegistryFacadeOptions
): T {
  const rules = options.registrations ?? defaultRegistrationRules();
  const byMethod = new Map(rules.map((rule) => [rule.method, rule]));
  const unregisterMethods = new Set(
    rules.map((rule) => rule.unregisterMethod).filter((method): method is string => Boolean(method))
  );
  interface OwnedRegistration {
    id?: string;
    unregisterMethod?: string;
    active: boolean;
    /** revoke 时同步失效的入口；异步 dispose 只作为兜底。 */
    revokeNow: (reason: string) => void;
    /** revoke 已触发但尚未完成的底层注销；dispose 需要等待它。 */
    revokedCleanup?: Promise<void>;
    removeScopeCleanup: () => void;
  }
  const ownedRegistrations = new Set<OwnedRegistration>();
  const objectTarget = target as RegistryTarget;

  const remember = (
    rule: ScopedRegistryRegistration,
    id: string | undefined,
    result: unknown,
    args: unknown[]
  ): unknown => {
    const unregisterMethod = rule.unregisterMethod;
    if (typeof result !== "function" && (!unregisterMethod || id === undefined)) return result;
    const key = rule.method + ":" + (id ?? "returned");
    let active = true;
    let removeScopeRevoke: () => void = () => undefined;
    let removeScopeCleanup: () => void = () => undefined;
    const entry = {} as OwnedRegistration;
    const clearOwnership = (removeDispose = true): boolean => {
      if (!active) return false;
      active = false;
      ownedRegistrations.delete(entry);
      removeScopeRevoke();
      if (removeDispose) removeScopeCleanup();
      return true;
    };
    const invokeUnregister = (...offArgs: unknown[]): unknown => {
      if (typeof result === "function") {
        return (result as AnyFunction).apply(target, offArgs);
      }
      const unregister = objectTarget[unregisterMethod!];
      if (typeof unregister !== "function") return undefined;
      const unregisterArgument = rule.unregisterArgument ?? rule.idArgument ?? 0;
      const unregisterArgs = [...args];
      unregisterArgs[unregisterArgument] = id;
      return unregister.apply(target, unregisterArgs);
    };
    const cleanup = async (_reason: string): Promise<void> => {
      if (!active) {
        if (entry.revokedCleanup) await entry.revokedCleanup;
        return;
      }
      if (!clearOwnership()) return;
      await invokeUnregister();
    };
    const revokeNow = (_reason: string): void => {
      if (!clearOwnership(false)) return;
      try {
        const pending = invokeUnregister();
        if (pending && typeof (pending as PromiseLike<unknown>).then === "function") {
          const revokedCleanup = Promise.resolve(pending).then(() => undefined);
          entry.revokedCleanup = revokedCleanup;
          revokedCleanup.catch(() => undefined);
        }
      } catch (error) {
        // revoke 必须继续同步撤权；把同步失败留给 dispose 的结果，不能
        // 重新暴露旧注册项，也不能让失败 Promise 变成未处理异常。
        entry.revokedCleanup = Promise.reject(error);
        entry.revokedCleanup.catch(() => undefined);
      }
    };
    entry.id = id;
    entry.unregisterMethod = unregisterMethod;
    entry.revokeNow = revokeNow;
    Object.defineProperty(entry, "active", {
      enumerable: true,
      configurable: false,
      get: () => active,
      set: (value: boolean) => { active = value; },
    });
    entry.removeScopeCleanup = removeScopeCleanup;
    ownedRegistrations.add(entry);
    removeScopeCleanup = scope.onDispose(
      cleanup,
      options.name + ":" + key,
      "after-teardown"
    );
    entry.removeScopeCleanup = removeScopeCleanup;
    removeScopeRevoke = scope.onRevoke(revokeNow);

    if (typeof result === "function") {
      return (...offArgs: unknown[]) => {
        if (!clearOwnership()) return undefined;
        return (result as AnyFunction).apply(target, offArgs);
      };
    }
    return result;
  };

  return new Proxy(target, {
    get(current, property, receiver) {
      const value = Reflect.get(current, property, receiver);
      if (typeof value !== "function") return value;
      const rule = typeof property === "string" ? byMethod.get(property) : undefined;
      if (rule) {
        return (...args: unknown[]) => {
          scope.assertActive();
          const callArgs = [...args];
          if (rule.bindPluginIdArgument !== undefined && scope.identity.pluginId) {
            const claimedPluginId = callArgs[rule.bindPluginIdArgument];
            if (claimedPluginId !== undefined && claimedPluginId !== scope.identity.pluginId) {
              throw new Error(
                "Registry owner \"" + String(claimedPluginId) +
                "\" does not match plugin instance \"" + scope.identity.pluginId + "\""
              );
            }
            callArgs[rule.bindPluginIdArgument] = scope.identity.pluginId;
          }
          if (rule.ownerPluginIdProperty && scope.identity.pluginId) {
            const definition = callArgs[rule.idArgument ?? 0];
            if (definition && typeof definition === "object") {
              const claimedPluginId = (definition as Record<string, unknown>)[rule.ownerPluginIdProperty];
              if (claimedPluginId !== undefined && claimedPluginId !== scope.identity.pluginId) {
                throw new Error(
                  "Registry owner \"" + String(claimedPluginId) +
                  "\" does not match plugin instance \"" + scope.identity.pluginId + "\""
                );
              }
            }
          }
          const result = (value as AnyFunction).apply(target, callArgs);
          const id = rule.idArgument === undefined ? undefined : definitionId(callArgs[rule.idArgument]);
          return remember(rule, id, result, callArgs);
        };
      }
      // 插件主动注销只能操作自己在本作用域登记过的 id；例如
      // protected-outpoint 的 unregisterByOwner 属于领域批量操作，不在这里
      // 冒充单条资源注销，仍由领域接口自己做 owner 校验。
      if (typeof property === "string" && unregisterMethods.has(property)) {
        return (...args: unknown[]) => {
          scope.assertActive();
          const id = definitionId(args[0]) ?? (typeof args[0] === "string" ? args[0] : undefined);
          const owned = [...ownedRegistrations].find((entry) =>
            entry.active && entry.id === id && entry.unregisterMethod === property
          );
          if (!owned) {
            throw new Error(
              "Registry resource \"" + (id ?? "unknown") + "\" is not owned by this plugin instance"
            );
          }
          const result = (value as AnyFunction).apply(target, args);
          owned.active = false;
          ownedRegistrations.delete(owned);
          owned.removeScopeCleanup();
          return result;
        };
      }
      return (value as AnyFunction).bind(target);
    },
  }) as T;
}
