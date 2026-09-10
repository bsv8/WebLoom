import type {
  LifecycleDisposeResult,
  RemoteServiceReference,
} from "../contracts/lifecycle.js";
import type { PluginManifest } from "../contracts/plugin.js";
import {
  createPluginHost,
  type CreatePluginHostOptions,
  type PluginHost,
} from "../host/createPluginHost.js";
import { StartupPluginError } from "../host/createPluginHost.js";
import { createRuntimeUnitImplementationRegistry } from "../host/runtimeUnitImplementationRegistry.js";
import {
  createMessagePortServiceProvider,
  type MessagePortServiceProvider,
} from "../transport/messagePortServiceProvider.js";
import type { MessagePortServiceCallInput } from "../transport/messagePortServiceTransport.js";
import type { RuntimePluginDefinition } from "./pluginDefinitions.js";
import { materializePluginDefinitions } from "./pluginDefinitions.js";
import {
  createRuntimeMessageCodec,
  RUNTIME_ERROR_TYPE,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SNAPSHOT_TYPE,
  type RuntimeErrorMessage,
  type RuntimeSnapshot,
  type RuntimeSnapshotUnit,
} from "./runtimeProtocol.js";
import {
  RuntimeInitializationError,
  type RuntimeStatusListener,
  type RuntimeStatusSnapshot,
  type RuntimeAppState,
} from "./runtimeTypes.js";

export interface SharedWorkerScopeLike {
  onconnect: ((event: { ports: MessagePort[] }) => void) | null;
}

export interface StartSharedWorkerAppOptions extends Omit<CreatePluginHostOptions, "runtime" | "runtimeUnitImplementationRegistry"> {
  id: string;
  plugins: readonly RuntimePluginDefinition[];
  globalScope?: SharedWorkerScopeLike;
  /** SWCF-009 完成前的临时领域端口装配接缝。 */
  onPortConnect?: (event: { ports: MessagePort[] }) => void;
}

export interface SharedWorkerApp {
  readonly runtimeKind: "shared-worker";
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  ready(): Promise<void>;
  reconcile(): Promise<void>;
  state(): RuntimeStatusSnapshot;
  subscribe(listener: RuntimeStatusListener): () => void;
  dispose(reason?: string): Promise<LifecycleDisposeResult>;
}

interface WorkerEndpoint {
  port: MessagePort;
  provider: MessagePortServiceProvider;
  removeMessage: () => void;
  closed: boolean;
}

function makeRuntimeInstanceId(runtimeId: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${runtimeId}:${crypto.randomUUID()}`;
    }
  } catch {
    // 仅用于 Runtime 身份去重。
  }
  return `${runtimeId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startupDetails(error: unknown): { pluginId?: string; unitId?: string; message: string } {
  if (error instanceof StartupPluginError) {
    return { pluginId: error.details.pluginId, unitId: error.details.unitId, message: error.details.error ?? error.message };
  }
  if (error instanceof RuntimeInitializationError) {
    return { pluginId: error.details.pluginId, unitId: error.details.unitId, message: error.message };
  }
  return { message: errorMessage(error) };
}

function addPortListener(port: MessagePort, listener: (event: MessageEvent) => void): () => void {
  port.addEventListener("message", listener);
  return () => port.removeEventListener("message", listener);
}

function post(port: MessagePort, message: unknown): void {
  try { port.postMessage(message); } catch { /* 端口已断开 */ }
}

/** 在当前 SharedWorkerGlobalScope 中安装唯一的 Worker Runtime。 */
export function startSharedWorkerApp(options: StartSharedWorkerAppOptions): SharedWorkerApp {
  if (!options || typeof options.id !== "string" || options.id.trim() === "") {
    throw new Error("SharedWorker runtime id must be a non-empty string");
  }
  const workerScope = options.globalScope
    ?? ("onconnect" in globalThis ? globalThis as unknown as SharedWorkerScopeLike : undefined);
  if (!workerScope) {
    throw new RuntimeInitializationError({
      phase: "validate",
      error: "startSharedWorkerApp must run in a SharedWorkerGlobalScope",
    });
  }

  const runtimeId = options.id;
  const runtimeInstanceId = makeRuntimeInstanceId(runtimeId);
  const listeners = new Set<RuntimeStatusListener>();
  const endpoints = new Set<WorkerEndpoint>();
  const codec = createRuntimeMessageCodec();
  let runtimeState: Exclude<RuntimeAppState, "disconnected"> = "starting";
  let revision = 0;
  let host: PluginHost | undefined;
  let manifests: readonly PluginManifest[] = [];
  let disposed = false;
  let acceptingConnections = true;
  let disposePromise: Promise<LifecycleDisposeResult> | undefined;
  let startupError: unknown;

  const serviceReferences = (): RemoteServiceReference[] => {
    // A stopping/disposed Runtime has no callable services. Keeping the
    // directory empty is also what synchronously revokes Provider pending
    // calls before the terminal snapshot is published.
    if (!host || runtimeState !== "ready") return [];
    const services: RemoteServiceReference[] = [];
    for (const manifest of manifests) {
      const state = host.state(manifest.id);
      const unit = manifest.units?.find((candidate) => candidate.id === state.unitId) ?? manifest.units?.[0];
      if (!unit || unit.runtime === undefined || !state.instanceId || state.kind !== "enabled") continue;
      const scope = host.scope(manifest.id);
      const attributes = Object.freeze({ ...(scope?.identity.attributes ?? {}) });
      for (const capability of unit.provides ?? []) {
        services.push({
          capabilityId: capability,
          contractVersion: unit.providedContracts?.[capability] ?? `${capability}.v1`,
          runtime: unit.runtime,
          runtimeInstanceId,
          serviceInstanceId: state.instanceId,
          status: "ready",
          attributes,
        });
      }
    }
    return services;
  };

  const currentSnapshot = (): RuntimeStatusSnapshot => Object.freeze({
    runtimeId,
    runtimeKind: "shared-worker",
    runtimeInstanceId,
    state: runtimeState,
    revision,
    units: Object.freeze(host && runtimeState !== "failed"
      ? manifests.flatMap((manifest) => {
          const state = host?.state(manifest.id);
          return (state?.units ?? []).map((unit) => ({
            pluginId: unit.pluginId,
            unitId: unit.unitId,
            runtime: unit.runtime,
            ...(unit.instanceId !== undefined ? { instanceId: unit.instanceId } : {}),
            state: unit.kind,
          } satisfies RuntimeSnapshotUnit));
        })
      : []),
    services: Object.freeze(serviceReferences()),
  });

  const emit = (): void => {
    const snapshot = currentSnapshot();
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch { /* observer isolation */ }
    }
  };

  const runtimeSnapshot = (): RuntimeSnapshot => ({
    type: RUNTIME_SNAPSHOT_TYPE,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId,
    runtimeKind: "shared-worker",
    runtimeInstanceId,
    revision,
    state: runtimeState,
    units: currentSnapshot().units,
    services: serviceReferences(),
  });

  const publishEndpoint = (endpoint: WorkerEndpoint): void => {
    if (endpoint.closed) return;
    endpoint.provider.setServices(serviceReferences());
    post(endpoint.port, codec.encode(runtimeSnapshot() as unknown as Record<string, unknown>));
  };

  const publishAll = (): void => {
    for (const endpoint of [...endpoints]) publishEndpoint(endpoint);
  };

  const closeEndpoint = (endpoint: WorkerEndpoint, _reason: string): void => {
    if (endpoint.closed) return;
    endpoint.closed = true;
    endpoints.delete(endpoint);
    endpoint.removeMessage();
    endpoint.provider.dispose();
  };

  const sendError = (
    port: MessagePort,
    code: RuntimeErrorMessage["code"],
    message: string,
    details: { pluginId?: string; unitId?: string; phase?: RuntimeErrorMessage["phase"] } = {},
  ): void => {
    const error: RuntimeErrorMessage = {
      type: RUNTIME_ERROR_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      code,
      message,
      ...(details.pluginId !== undefined ? { pluginId: details.pluginId } : {}),
      ...(details.unitId !== undefined ? { unitId: details.unitId } : {}),
      ...(details.phase !== undefined ? { phase: details.phase } : {}),
    };
    post(port, error);
  };

  const isAcceptingConnections = (): boolean => (
    acceptingConnections
      && runtimeState !== "stopping"
      && runtimeState !== "disposed"
      && !disposed
  );

  const rejectLateConnection = (port: MessagePort): void => {
    // The port never becomes an endpoint and the domain hook is never called.
    // Publish the current terminal snapshot so a late client fails at its
    // call-first boundary immediately instead of waiting for a timeout. Delay
    // close by one task so the snapshot has a delivery opportunity.
    post(port, codec.encode(runtimeSnapshot() as unknown as Record<string, unknown>));
    setTimeout(() => {
      try { port.close(); } catch { /* noop */ }
    }, 0);
  };

  const handleCall = async (input: MessagePortServiceCallInput): Promise<unknown> => {
    if (!host || runtimeState !== "ready") throw new Error("SharedWorker Runtime is not ready");
    const { message, reference } = input;
    if (reference.runtimeInstanceId !== runtimeInstanceId
      || reference.runtime !== "shared-worker"
      || reference.status !== "ready") {
      throw new Error("Runtime service reference is stale");
    }
    const manifest = manifests.find((candidate) => host?.state(candidate.id).instanceId === reference.serviceInstanceId);
    if (!manifest) throw new Error("Runtime service provider is no longer active");
    const state = host.state(manifest.id);
    if (state.kind !== "enabled" || state.instanceId !== reference.serviceInstanceId) {
      throw new Error("Runtime service provider is no longer active");
    }
    const unit = manifest.units?.find((candidate) => candidate.id === state.unitId);
    if (!unit || unit.runtime !== "shared-worker" || !unit.provides?.includes(reference.capabilityId)) {
      throw new Error("Runtime capability is not declared");
    }
    const expectedVersion = unit.providedContracts?.[reference.capabilityId] ?? `${reference.capabilityId}.v1`;
    if (expectedVersion !== reference.contractVersion) throw new Error("Runtime capability contract mismatch");
    const value = host.capabilities.get<unknown>(reference.capabilityId);
    if (input.signal.aborted) throw input.signal.reason ?? new Error("Runtime service request cancelled");
    const request = message.request;
    if (typeof value === "function") return await (value as (request: unknown, signal: AbortSignal) => unknown)(request, input.signal);
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (typeof object.handle === "function") return await (object.handle as (request: unknown, signal: AbortSignal) => unknown)(request, input.signal);
      if (request && typeof request === "object" && typeof (request as { method?: unknown }).method === "string") {
        const method = (request as { method: string }).method;
        const methodValue = object[method];
        if (typeof methodValue === "function") {
          const args = (request as { args?: unknown[] }).args;
          return await (methodValue as (...args: unknown[]) => unknown)(...(Array.isArray(args) ? args : []));
        }
      }
    }
    throw new Error(`Runtime capability "${reference.capabilityId}" does not expose an RPC handler`);
  };

  const attachPort = (port: MessagePort): void => {
    let endpoint: WorkerEndpoint | undefined;
    let removeMessage: () => void = () => undefined;
    const onMessageError = (): void => {
      if (endpoint) closeEndpoint(endpoint, "MessagePort error");
    };
    endpoint = {
      port,
      provider: undefined as unknown as MessagePortServiceProvider,
      removeMessage: () => undefined,
      closed: false,
    };
    endpoint.provider = createMessagePortServiceProvider({
      port,
      codec,
      services: serviceReferences,
      handleCall,
    });
    endpoints.add(endpoint);
    const onMessage = (event: MessageEvent): void => {
      // Runtime has no client control messages. Domain listeners installed by
      // onPortConnect own their own message schema on this same port.
      void event;
    };
    removeMessage = addPortListener(port, onMessage);
    endpoint.removeMessage = () => {
      removeMessage();
      port.removeEventListener("messageerror", onMessageError);
    };
    port.addEventListener("messageerror", onMessageError);
    port.start();
    publishEndpoint(endpoint);
  };

  // Install onconnect before asynchronous plugin startup so every new port
  // immediately receives a complete starting snapshot.
  workerScope.onconnect = (event) => {
    const ports = event.ports ?? [];
    if (!isAcceptingConnections()) {
      for (const port of ports) rejectLateConnection(port);
      return;
    }
    try {
      options.onPortConnect?.(event);
    } catch (error) {
      const detail = startupDetails(error);
      for (const port of ports) {
        sendError(port, "runtime_initialization_failed", detail.message, {
          pluginId: detail.pluginId,
          unitId: detail.unitId,
          phase: "startup",
        });
        try { port.close(); } catch { /* noop */ }
      }
      return;
    }
    // A synchronous domain hook may itself initiate disposal. Re-check before
    // creating any Provider endpoint so the hook cannot open a new callable
    // port after the lifecycle gate has closed.
    if (!isAcceptingConnections()) {
      for (const port of ports) rejectLateConnection(port);
      return;
    }
    for (const port of ports) attachPort(port);
  };

  let materialized: ReturnType<typeof materializePluginDefinitions> = [];
  let readyPromise: Promise<void>;
  try {
    materialized = materializePluginDefinitions(options.plugins, "shared-worker");
    manifests = materialized.map((item) => item.manifest);
    const implementations = createRuntimeUnitImplementationRegistry(materialized.map((item) => ({
      pluginId: item.manifest.id,
      unitId: item.unitId,
      setup: item.setup,
    })));
    const { id: _id, plugins: _plugins, globalScope: _scope, onPortConnect: _onPortConnect, ...hostOptions } = options;
    host = createPluginHost({
      ...hostOptions,
      runtime: "shared-worker",
      rootAttributes: { ...(hostOptions.rootAttributes ?? {}), runtimeId, runtimeInstanceId },
      runtimeUnitImplementationRegistry: implementations,
    });
    host.subscribe(() => {
      if (runtimeState !== "ready" || disposed) return;
      revision += 1;
      publishAll();
      emit();
    });
    readyPromise = host.registerAll(manifests).then(() => {
      if (runtimeState === "stopping" || disposed) return;
      const runtimeHost = host;
      if (!runtimeHost) throw new Error("SharedWorker Plugin Host is unavailable");
      const failedRequired = manifests.find((manifest) => {
        const required = manifest.meta.startup === "required" || manifest.meta.canDisable === false;
        return required && runtimeHost.state(manifest.id).kind !== "enabled";
      });
      if (failedRequired) {
        const state = runtimeHost.state(failedRequired.id);
        throw new StartupPluginError({
          pluginId: failedRequired.id,
          unitId: state.unitId ?? failedRequired.units?.[0]?.id ?? failedRequired.id,
          capabilities: [],
          state: state.kind,
          error: state.error ?? `Required plugin is ${state.kind}`,
        });
      }
      runtimeState = "ready";
      revision = Math.max(1, revision + 1);
      publishAll();
      emit();
    }).catch((error) => {
      // dispose() may have begun while required plugin startup was still
      // pending. Keep the stopping/terminal sequence authoritative; startup
      // must not resurrect a callable directory or overwrite its state with
      // a late failed snapshot.
      if (runtimeState === "stopping" || disposed) return;
      startupError = error;
      runtimeState = "failed";
      emit();
      const detail = startupDetails(error);
      for (const endpoint of [...endpoints]) {
        sendError(endpoint.port, "runtime_initialization_failed", detail.message, {
          pluginId: detail.pluginId,
          unitId: detail.unitId,
          phase: "startup",
        });
        closeEndpoint(endpoint, "Runtime initialization failed");
      }
      throw new RuntimeInitializationError({
        pluginId: detail.pluginId,
        unitId: detail.unitId,
        phase: "startup",
        error: detail.message,
      });
    });
  } catch (error) {
    startupError = error;
    runtimeState = "failed";
    emit();
    readyPromise = Promise.reject(error instanceof RuntimeInitializationError
      ? error
      : new RuntimeInitializationError({ phase: "validate", error: errorMessage(error) }));
    void readyPromise.catch(() => undefined);
  }

  const app: SharedWorkerApp = {
    runtimeKind: "shared-worker",
    runtimeId,
    runtimeInstanceId,
    ready: () => readyPromise,
    async reconcile() {
      if (!host) {
        await readyPromise;
        return;
      }
      if (runtimeState === "failed" || runtimeState === "stopping" || runtimeState === "disposed" || disposed) {
        await readyPromise;
        return;
      }
      await host.reconcile();
    },
    state: currentSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(currentSnapshot());
      return () => listeners.delete(listener);
    },
    dispose(reason = "shared worker runtime disposed") {
      if (disposePromise) return disposePromise;
      // Close admission before publishing stopping or entering async Host
      // drain. No later onconnect may reach a domain hook or Provider.
      acceptingConnections = false;
      runtimeState = "stopping";
      revision += 1;
      // Publish stopping while endpoints are still open. publishEndpoint also
      // clears the Provider directory, aborting pending calls before the
      // asynchronous Host drain starts.
      publishAll();
      emit();
      disposePromise = (async () => {
        let result: LifecycleDisposeResult;
        let failure: unknown;
        try {
          result = host
            ? await host.dispose(reason)
            : { scopeId: `runtime:${runtimeInstanceId}`, state: "stopped" as const, attempted: 0, released: 0, pending: [], errors: [], cleanupIncomplete: false };
        } catch (error) {
          failure = error;
          result = {
            scopeId: `runtime:${runtimeInstanceId}`,
            state: "stopped",
            attempted: 0,
            released: 0,
            pending: [],
            errors: [{ resourceId: "runtime.dispose", code: "lifecycle.cleanup_failed", message: errorMessage(error) }],
            cleanupIncomplete: true,
          };
        }

        // Keep both terminal snapshots observable before closing any port.
        // The Provider has already been emptied by the stopping publication;
        // this second publication gives clients a deterministic terminal state.
        runtimeState = "disposed";
        revision += 1;
        publishAll();
        emit();
        disposed = true;
        for (const endpoint of [...endpoints]) closeEndpoint(endpoint, reason);
        if (failure) throw failure;
        return result;
      })();
      return disposePromise;
    },
  };
  void startupError;
  return app;
}
