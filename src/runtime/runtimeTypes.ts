import type {
  LifecycleDisposeResult,
  RemoteServiceProxy,
  RemoteServiceReference,
  RuntimeKind,
} from "../contracts/lifecycle.js";
import type { PluginHost } from "../host/createPluginHost.js";
import type { RuntimeSnapshotUnit } from "./runtimeProtocol.js";

export type RuntimeAppState =
  | "starting"
  | "ready"
  | "stopping"
  | "failed"
  | "disposed"
  | "disconnected";

export interface RuntimeStatusSnapshot {
  runtimeId: string;
  runtimeKind: RuntimeKind;
  runtimeInstanceId: string;
  state: RuntimeAppState;
  revision: number;
  units: readonly RuntimeSnapshotUnit[];
  services: readonly RemoteServiceReference[];
  error?: string;
}

export type RuntimeStatusListener = (snapshot: RuntimeStatusSnapshot) => void;

export interface WindowApp {
  readonly runtimeKind: "window-main";
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  /** 已由 createWindowApp 装配并注册完成的本地 Host。 */
  readonly host: PluginHost;
  state(): RuntimeStatusSnapshot;
  /** 获取当前本地 capability；停止或销毁后同步抛错。 */
  capability<T>(capabilityId: string): T;
  subscribe(listener: RuntimeStatusListener): () => void;
  dispose(reason?: string): Promise<LifecycleDisposeResult>;
}

export interface RuntimeHandle {
  readonly runtimeKind: "shared-worker";
  readonly runtimeId: string;
  /** 当前已观察到的 Worker 启动身份；首份快照前为 undefined。 */
  readonly runtimeInstanceId?: string;
  state(): RuntimeStatusSnapshot;
  capability<T = unknown>(capabilityId: string, options?: {
    contractVersion?: string;
  }): RemoteServiceProxy & { readonly serviceType?: T };
  subscribe(listener: RuntimeStatusListener): () => void;
  dispose(reason?: string): Promise<void>;
}

/** 跨 realm 初始化失败；不把 required 插件错误包装成成功状态。 */
export interface RuntimeInitializationErrorDetails {
  pluginId?: string;
  unitId?: string;
  phase: "validate" | "register" | "startup" | "snapshot";
  error: string;
}

export class RuntimeInitializationError extends Error {
  readonly code = "runtime_initialization_failed" as const;
  readonly details: RuntimeInitializationErrorDetails;

  constructor(details: RuntimeInitializationErrorDetails) {
    super(
      `Runtime initialization failed${details.pluginId ? ` for ${details.pluginId}` : ""}`
        + ` during ${details.phase}: ${details.error}`,
    );
    this.name = "RuntimeInitializationError";
    this.details = details;
  }
}

export class RuntimeUnavailableError extends Error {
  readonly code = "transport_unavailable" as const;

  constructor(message = "Runtime is unavailable") {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}
