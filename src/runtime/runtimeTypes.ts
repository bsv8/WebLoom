import type { Capability, CapabilityClient, RemoteCapability } from "../contracts/capability.js";
import type { LifecycleDisposeResult, RuntimeKind, RuntimeSnapshot } from "../contracts/lifecycle.js";
import type { PluginState } from "../contracts/plugin.js";
import type { PluginHost, HostInspection } from "../host/createPluginHost.js";

export type RuntimeAppState = RuntimeSnapshot["state"] | "disconnected";

export interface RuntimeStatusSnapshot extends Omit<RuntimeSnapshot, "protocolVersion" | "state"> {
  /** 当前框架协议。 */
  readonly protocolVersion: string;
  /** Runtime 当前状态。 */
  readonly state: RuntimeAppState;
  /** 脱敏 Runtime 错误。 */
  readonly error?: string;
}

export type RuntimeStatusListener = (snapshot: RuntimeStatusSnapshot) => void;

export interface AppLike {
  /** Runtime 类型。 */
  readonly runtimeKind: RuntimeKind;
  /** Runtime 逻辑标识。 */
  readonly runtimeId: string;
  /** Runtime 启动实例。 */
  readonly runtimeInstanceId: string;
  /** 当前不可变状态。 */
  state(): RuntimeStatusSnapshot;
  /** 按插件读取稳定状态；RuntimeHandle 可能没有本地插件状态。 */
  pluginState?(pluginId: string): PluginState | undefined;
  /** 订阅状态。 */
  subscribe(listener: RuntimeStatusListener): () => void;
  /** 结构化诊断。 */
  inspect(): HostInspection | Readonly<Record<string, unknown>>;
  /** 释放本端资源。 */
  dispose(reason?: string): Promise<LifecycleDisposeResult | void>;
}

export interface WindowApp extends AppLike {
  readonly runtimeKind: "window-main";
  /** 获取本地 typed capability。 */
  capability<C extends Capability>(capability: C): CapabilityClient<C>;
  /** 可选本地 typed capability。 */
  optionalCapability<C extends Capability>(capability: C): CapabilityClient<C> | undefined;
}

export interface RuntimeHandle extends AppLike {
  readonly runtimeKind: "shared-worker";
  /** 获取远程 typed RPC/stream capability；代理构造不等待 Worker。 */
  capability<C extends RemoteCapability>(capability: C): CapabilityClient<C>;
  /** 当前已观察到的 remote capability。 */
  optionalCapability<C extends RemoteCapability>(capability: C): CapabilityClient<C> | undefined;
}

export class RuntimeInitializationError extends Error {
  readonly code = "runtime_initialization_failed" as const;
  readonly details: { readonly pluginId?: string; readonly unitId?: string; readonly phase: "validate" | "register" | "startup" | "snapshot"; readonly error: string };
  constructor(details: { readonly pluginId?: string; readonly unitId?: string; readonly phase: "validate" | "register" | "startup" | "snapshot"; readonly error: string }) {
    super(`Runtime initialization failed${details.pluginId ? ` for ${details.pluginId}` : ""} during ${details.phase}: ${details.error}`);
    this.name = "RuntimeInitializationError";
    this.details = Object.freeze({ ...details });
  }
}

export class RuntimeUnavailableError extends Error {
  readonly code = "transport_unavailable" as const;
  constructor(message = "Runtime is unavailable") { super(message); this.name = "RuntimeUnavailableError"; }
}
