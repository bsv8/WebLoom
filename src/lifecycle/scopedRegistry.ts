// 把已有 Registry 绑定到插件实例作用域。
//
// 该 facade 不改变 Registry 的业务类型，只在注册方法周围登记所有权：
// 资源创建成功后立刻绑定 instance scope，停止时按 after-teardown 阶段
// 注销。晚到的注册在撤销后立即被回收，不会复活旧实例的条目。

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
  readonly ownerPluginIdProperty?: string;
  /**
   * 定义对象中的 ownerInstanceId 字段。
   *
   * 框架按当前 Scope 身份写入（不是校验字符串）：调用方不需要自填归属，传入他人
   * 实例则直接拒绝。框架签发的实例归属是注册项的真实 owner，比 pluginId 更强。
   */
  readonly ownerInstanceIdProperty?: string;
  /**
   * 更新方法的 id 参数位置。
   *
   * 声明后该方法按“更新已有条目”处理：只允许更新本实例登记过的条目，并拒绝改写归属
   * 字段（`immutableProperties`）。未声明时更新方法只是普通透传。
   */
  readonly updateIdArgument?: number;
  /** 更新时禁止改写的字段（通常是 ownerInstanceId / ownerPluginId）。 */
  readonly immutableProperties?: readonly string[];
}

export interface CreateScopedRegistryFacadeOptions {
  /** 日志和作用域资源中显示的注册表名。 */
  name: string;
  /** 注册方法规则；缺省只包装 register(item)。 */
  registrations?: readonly ScopedRegistryRegistration[];
}

/**
 * 注册表目标 → 条目 id → 当前 owner 与注册世代。
 *
 * 归属与世代都由框架维护，而不是由条目或调用方声明。写操作（更新/注销）必须同时匹配
 * “当前 owner 是我”且“注册世代仍是我登记的那一代”：同名条目被新实例接管后，旧门面的
 * 历史登记记录不再有效，不能再改写或删除新实例的条目。只统计经过框架门面的注册；
 * 绕过 facade 直接改目标不属于受支持的接入路径。
 */
interface EntryOwnership {
  /** 当前 owner 实例。 */
  readonly instanceId: string;
  /** 注册世代；同一 id 每次成功登记都递增。 */
  readonly generation: number;
}

const entryOwners = new WeakMap<object, Map<string, EntryOwnership>>();

function ownersOf(target: object): Map<string, EntryOwnership> {
  const existing = entryOwners.get(target);
  if (existing) return existing;
  const created = new Map<string, EntryOwnership>();
  entryOwners.set(target, created);
  return created;
}

/**
 * 记录一次成功登记：同一 id 的世代递增，因此旧门面的世代会自动过期。
 *
 * 返回本次登记的世代，写操作用它复核“仍是我登记的那一代”。
 */
function recordOwnership(target: object, id: string, instanceId: string): number {
  const owners = ownersOf(target);
  const previous = owners.get(id);
  const generation = (previous?.generation ?? 0) + 1;
  owners.set(id, { instanceId, generation });
  return generation;
}

/** 当前 owner 是否仍是“我登记的那一代”。 */
function ownsGeneration(target: object, id: string, instanceId: string, generation: number | undefined): boolean {
  const current = ownersOf(target).get(id);
  if (!current || current.instanceId !== instanceId) return false;
  return generation === undefined || current.generation === generation;
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
): { facade: T; stage: (entry: unknown, options?: { method?: string }) => ScopedRegistryCommit } {
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
    /** 本次登记的世代；写操作据此复核条目仍属本门面。 */
    generation?: number;
    /** 底层异步注册仍在进行；撤销必须等它结束，否则条目会在撤销后残留。 */
    pendingRegistration?: Promise<void>;
    removeScopeCleanup: () => void;
  }
  const ownedRegistrations = new Set<OwnedRegistration>();
  const objectTarget = target as RegistryTarget;

  const remember = (
    rule: ScopedRegistryRegistration,
    id: string | undefined,
    result: unknown,
    args: unknown[],
    generation?: number
  ): unknown => {
    const unregisterMethod = rule.unregisterMethod;
    // 条件提交路径没有底层返回值，但仍需要登记归属世代，便于撤销清理与写操作校验。
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
      // 旧实例的清理只能注销仍然属于自己的那一代条目：同名条目已被新实例接管时，
      // 直接调用 unregister 会把新实例的注册项删掉。
      if (rule.ownerInstanceIdProperty && id !== undefined && scope.identity.instanceId) {
        if (!ownsGeneration(objectTarget, id, scope.identity.instanceId, entry.generation)) return undefined;
      }
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
    // 底层注册可能是异步的：撤销发生得比注册完成更早时，必须在注册完成后复核 scope，
    // 已撤销就立刻回收这条刚写入的条目，否则它会以旧实例的身份残留。
    const pending = result && typeof (result as PromiseLike<unknown>).then === "function"
      ? Promise.resolve(result as PromiseLike<unknown>)
      : undefined;
    if (pending) {
      const settled = pending.then(
        () => {
          if (active && scope.state === "active") return;
          try {
            // 只在条目仍属于本实例的同一代时回收，避免删掉同名新实例的条目。
            if (rule.ownerInstanceIdProperty && id !== undefined && scope.identity.instanceId) {
              if (!ownsGeneration(objectTarget, id, scope.identity.instanceId, entry.generation)) return;
            }
            const revokeResult = invokeUnregister();
            if (revokeResult && typeof (revokeResult as PromiseLike<unknown>).then === "function") {
              (revokeResult as PromiseLike<unknown>).then(() => clearRecordedOwner(), () => undefined);
            } else clearRecordedOwner();
          } catch { /* 同步失败由 dispose 结果承载 */ }
        },
        () => undefined,
      );
      entry.pendingRegistration = settled;
      settled.catch(() => undefined);
    }

    const clearRecordedOwner = (): void => {
      if (rule.ownerInstanceIdProperty && id !== undefined && scope.identity.instanceId) {
        const owners = ownersOf(objectTarget);
        const current = owners.get(id);
        if (current && current.instanceId === scope.identity.instanceId && (entry.generation === undefined || current.generation === entry.generation)) {
          owners.delete(id);
        }
      }
    };
    const cleanup = async (_reason: string): Promise<void> => {
      // 异步注册尚未完成时必须等待：先注销会与稍后写入的条目错位。
      if (entry.pendingRegistration) await entry.pendingRegistration;
      if (!active) {
        if (entry.revokedCleanup) await entry.revokedCleanup;
        return;
      }
      if (!clearOwnership()) return;
      await invokeUnregister();
      clearRecordedOwner();
    };
    const revokeNow = (_reason: string): void => {
      if (!clearOwnership(false)) return;
      try {
        // 底层注册仍在进行时，注销要延后到它结束；否则条目会在撤销后残留。
        if (entry.pendingRegistration) {
          entry.revokedCleanup = entry.pendingRegistration.then(() => {
            if (entry.active) return undefined;
            const result = invokeUnregister();
            return Promise.resolve(result).then(() => undefined);
          }).catch(() => undefined);
          entry.revokedCleanup.catch(() => undefined);
          return;
        }
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
    entry.generation = generation;
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

  /**
   * 可验证的条件提交：把“写入注册表”推迟到 commit()，并在真正写入前复核围栏。
   *
   * 异步注册的危险在于底层写入发生在调用方控制之外：调用返回后条目仍可能被写入，此时
   * 实例也许已撤销、同名条目也许已被新实例接管。stage() 由框架在 commit() 里执行写入，
   * 因此撤销或接管都可以让提交整体失败，而不会留下旧实例的条目。
   */
  const stage = (entry: unknown, options: { method?: string } = {}): { commit(): Promise<boolean> } => {
    const rule = byMethod.get(options.method ?? "register");
    const idArgument = rule?.idArgument ?? 0;
    // 常见形态是 register(entry)：此时定义对象本身就是第一个参数。
    const argument = idArgument === 0 ? entry : (entry as Record<string, unknown> | null | undefined)?.[idArgument];
    const id = definitionId(argument);
    return {
      async commit(): Promise<boolean> {
        // 围栏一：实例仍然有效。
        if (scope.state !== "active") return false;
        if (!rule) throw new Error("Staged registry commit requires a registration rule");
        // 围栏二：同一 id 尚未被别的实例接管。
        if (rule.ownerInstanceIdProperty && id !== undefined && scope.identity.instanceId) {
          const current = ownersOf(objectTarget).get(id);
          if (current && current.instanceId !== scope.identity.instanceId) return false;
        }
        const callArgs: unknown[] = [];
        callArgs[idArgument] = rule.ownerInstanceIdProperty && argument && typeof argument === "object"
          ? Object.assign({}, argument as Record<string, unknown>, { [rule.ownerInstanceIdProperty]: scope.identity.instanceId })
          : argument;
        const method = objectTarget[rule.method];
        if (typeof method !== "function") throw new Error("Staged registry commit requires a callable registration method");
        const result = method.apply(target, callArgs);
        if (result && typeof (result as PromiseLike<unknown>).then === "function") await result;
        if (scope.state !== "active") {
          // 提交期间被撤销：立刻回滚这次写入（归属世代已经记为本实例，可安全撤销）。
          const rollback = objectTarget[rule.unregisterMethod ?? "unregister"];
          if (typeof rollback === "function") rollback.apply(target, [id]);
          return false;
        }
        if (rule.ownerInstanceIdProperty && id !== undefined && scope.identity.instanceId) {
          const generation = recordOwnership(objectTarget, id, scope.identity.instanceId);
          // 登记归属记录，使撤销清理与后续写操作校验都能看到这一代。
          remember(rule, id, undefined, callArgs, generation);
        }
        return true;
      },
    };
  };

  const facade = new Proxy(target, {
    get(current, property, receiver) {
      const value = Reflect.get(current, property, receiver);
      if (typeof value !== "function") return value;
      // 更新方法与注销同样受归属约束：不能修改不属于自己的条目，也不能改写归属字段。
      const updateRule = typeof property === "string" ? byMethod.get(property) : undefined;
      const updateIdArgument = updateRule?.updateIdArgument;
      if (updateRule && updateIdArgument !== undefined) {
        const immutableProperties = updateRule.immutableProperties ?? [];
        return (...args: unknown[]) => {
          scope.assertActive();
          const raw = args[updateIdArgument];
          const id = definitionId(raw) ?? (typeof raw === "string" ? raw : undefined);
          const owned = [...ownedRegistrations].find((entry) => entry.active && entry.id === id && entry.unregisterMethod === updateRule.unregisterMethod);
          if (!owned) {
            throw new Error(
              "Registry resource \"" + (id ?? "unknown") + "\" is not owned by this plugin instance"
            );
          }
          // 同名接管后旧门面的更新同样被拒：必须仍是本实例登记的那一代。
          if (id !== undefined && scope.identity.instanceId
            && !ownsGeneration(objectTarget, id, scope.identity.instanceId, owned.generation)) {
            throw new Error(
              "Registry resource \"" + id + "\" was re-registered by another plugin instance"
            );
          }
          const patch = args[updateIdArgument + 1];
          if (patch && typeof patch === "object") {
            for (const immutable of immutableProperties) {
              if (!Object.prototype.hasOwnProperty.call(patch, immutable)) continue;
              const claimed = (patch as Record<string, unknown>)[immutable];
              const current = scope.identity.instanceId;
              if (immutable === updateRule.ownerInstanceIdProperty) {
                if (claimed !== undefined && claimed !== current) {
                  throw new Error(
                    "Registry owner instance \"" + String(claimed) + "\" does not match plugin instance \"" + current + "\""
                  );
                }
                // 归属只能由框架写入：即使传了正确值也从补丁里剥离，避免伪造“自行改写”。
                delete (patch as Record<string, unknown>)[immutable];
              } else if (claimed !== undefined) {
                throw new Error(
                  "Registry property \"" + immutable + "\" is immutable for plugin instance \"" + String(scope.identity.pluginId) + "\""
                );
              }
            }
          }
          return (value as AnyFunction).apply(target, args);
        };
      }
      const rule = typeof property === "string" ? byMethod.get(property) : undefined;
      if (rule) {
        return (...args: unknown[]) => {
          scope.assertActive();
          const callArgs = [...args];
          let committedGeneration: number | undefined;
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
          if (rule.ownerInstanceIdProperty && rule.updateIdArgument === undefined) {
            const argumentIndex = rule.idArgument ?? 0;
            const definition = callArgs[argumentIndex];
            if (!definition || typeof definition !== "object") {
              throw new Error("Registry definition must be an object to bind owner instance");
            }
            const claimed = (definition as Record<string, unknown>)[rule.ownerInstanceIdProperty];
            const bound = scope.identity.instanceId;
            if (claimed !== undefined && claimed !== bound) {
              throw new Error(
                "Registry owner instance \"" + String(claimed) +
                "\" does not match plugin instance \"" + bound + "\""
              );
            }
            // 写入框架签发的归属，不修改调用方传入的对象本身。
            callArgs[argumentIndex] = Object.assign({}, definition as Record<string, unknown>, { [rule.ownerInstanceIdProperty]: bound });
          }
          if (rule.ownerPluginIdProperty && scope.identity.pluginId && rule.updateIdArgument === undefined) {
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
          // 记录框架判定的归属，供注销前的所有权复核使用。
          if (rule.ownerInstanceIdProperty && rule.updateIdArgument === undefined && id !== undefined && scope.identity.instanceId) {
            // 每次成功登记都开启新一代：同名条目被重新登记后，旧门面的世代立即过期。
            committedGeneration = recordOwnership(objectTarget, id, scope.identity.instanceId);
          }
          return remember(rule, id, result, callArgs, committedGeneration);
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
          // 历史登记记录不足以证明所有权：同名条目被新实例接管后，旧门面必须被拒。
          if (id !== undefined && scope.identity.instanceId
            && !ownsGeneration(objectTarget, id, scope.identity.instanceId, owned.generation)) {
            throw new Error(
              "Registry resource \"" + id + "\" was re-registered by another plugin instance"
            );
          }
          if (id !== undefined && scope.identity.instanceId) ownersOf(objectTarget).delete(id);
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

  return { facade, stage };
}

/**
 * 条件提交句柄。
 *
 * `commit()` 返回 `true` 表示条目确实登记在本实例名下；返回 `false` 表示围栏未通过
 * （实例已撤销，或同一 id 已被别的实例接管），此时底层不会留下本实例的条目。
 */
export interface ScopedRegistryCommit {
  commit(): Promise<boolean>;
}

/**
 * 为一个注册门面创建条件提交器（PSM-R05 / REVIEW-03）。
 *
 * 产品的注册表如果需要异步登记（内部 await 后才写入），必须用它而不是直接调用
 * `register`：条件提交器由框架在真正写入前复核实例有效性与条目世代，因此撤销或同名
 * 接管都会让提交整体失败，而不会把旧实例的条目写进底层存储。
 *
 * 同步登记的产品继续直接使用门面的 `register()`，那条路径本身是安全的。
 */
export function createScopedRegistryCommitter<T extends object>(
  facade: T,
  scope: LifecycleScope,
): (entry: unknown, options?: { method?: string }) => ScopedRegistryCommit {
  const owner = scopedRegistryViewOwner(facade);
  if (!owner) throw new Error("createScopedRegistryCommitter requires a framework-issued registry view");
  return owner.stage;
}

/** 绑定结果：注册门面、条件提交器与框架签发的实例归属。 */
export interface ScopedRegistryView<T extends object> {
  /** 只能传给本实例使用的注册门面。 */
  readonly view: T;
  /** 本视图所属的真实运行实例（由 Scope 身份决定，调用方不能自填）。 */
  readonly ownerInstanceId: string;
  /** 本视图所属插件标识（只读诊断）。 */
  readonly ownerPluginId: string | undefined;
  /**
   * 条件提交：把写入推迟到 `commit()`，由框架在真正写入前复核实例有效性与条目世代。
   * 异步登记的产品必须用它，直接 `register()` 的写入无法被框架拦截。
   */
  stage(entry: unknown, options?: { method?: string }): ScopedRegistryCommit;
}

const issuedRegistryViews = new WeakMap<object, ScopedRegistryView<object>>();

/**
 * 框架提供的可信注册接入路径（PSM-R05）。
 *
 * 产品实现注册表与条目 schema；归属绑定、越权注销、撤销清理和迟到注册拒绝由框架
 * 完成。调用方只需要交出自己的 `ctx.scope`，不需要（也不允许）自己填写 owner
 * 字符串：归属一律来自 Scope 签发的运行实例身份。
 *
 * 返回的门面只能交给本实例使用；把它传给别的实例不会被当成合法调用方。
 */
export function createScopedRegistryView<T extends object>(
  target: T,
  scope: LifecycleScope,
  options: CreateScopedRegistryFacadeOptions
): ScopedRegistryView<T> {
  // scope 必须是框架签发的运行实例作用域；没有插件身份的 scope（root 等）无法
  // 作为注册归属，否则任何装配层对象都能自称某个插件的注册方。
  const identity = scope.identity;
  if (typeof identity.pluginId !== "string" || identity.pluginId === "" || typeof identity.instanceId !== "string" || identity.instanceId === "") {
    throw new Error("Scoped registry views require a plugin instance scope");
  }
  scope.assertActive();
  const { facade, stage } = createScopedRegistryFacade(target, scope, options);
  const entry: ScopedRegistryView<T> = Object.freeze({
    view: facade,
    ownerInstanceId: identity.instanceId,
    ownerPluginId: identity.pluginId,
    stage,
  });
  issuedRegistryViews.set(facade as unknown as object, entry as unknown as ScopedRegistryView<object>);
  return entry;
}

/** 判断对象是否由 createScopedRegistryView 签发；用于拒绝来历不明的门面。 */
export function isIssuedScopedRegistryView(value: unknown): boolean {
  return typeof value === "object" && value !== null && issuedRegistryViews.has(value);
}

/** 读取签发信息；非签发对象返回 undefined。 */
export function scopedRegistryViewOwner(value: unknown): ScopedRegistryView<object> | undefined {
  return typeof value === "object" && value !== null ? issuedRegistryViews.get(value) : undefined;
}
