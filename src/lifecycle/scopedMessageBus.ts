// 把共享 MessageBus 绑定到一个插件实例作用域。
//
// MessageBus 本身不拥有插件生命周期；这个 facade 负责把订阅、handler、
// 请求和取消信号登记到当前 Scope。这样同步撤权后，迟到的消息不会继续
// 进入已经失效的插件实例。

import type {
  DispatchOptions,
  HandlerOptions,
  Message,
  MessageBus,
  MessageHandler,
  PublishOptions,
  RequestOptions,
} from "../contracts/messageBus.js";
import { LifecycleScopeRevokedError } from "../contracts/lifecycle.js";
import type { LifecycleScope } from "../contracts/lifecycle.js";

interface MergedSignal {
  signal: AbortSignal;
  dispose(): void;
}

function mergeSignals(scopeSignal: AbortSignal, requestSignal?: AbortSignal): MergedSignal {
  if (!requestSignal) return { signal: scopeSignal, dispose: () => undefined };
  if (scopeSignal.aborted) {
    const controller = new AbortController();
    controller.abort(scopeSignal.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  if (requestSignal.aborted) {
    const controller = new AbortController();
    controller.abort(requestSignal.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal) => {
    try {
      controller.abort(source.reason);
    } catch {
      controller.abort();
    }
  };
  const onScopeAbort = () => abortFrom(scopeSignal);
  const onRequestAbort = () => abortFrom(requestSignal);
  scopeSignal.addEventListener("abort", onScopeAbort, { once: true });
  requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      scopeSignal.removeEventListener("abort", onScopeAbort);
      requestSignal.removeEventListener("abort", onRequestAbort);
    },
  };
}

function withScopeCleanup(scope: LifecycleScope, cleanup: () => void): () => void {
  let active = true;
  let removeRevoke: () => void = () => undefined;
  let removeDispose: () => void = () => undefined;
  const runCleanup = () => {
    if (!active) return;
    active = false;
    removeRevoke();
    removeDispose();
    cleanup();
  };
  removeRevoke = scope.onRevoke(runCleanup);
  removeDispose = scope.onDispose(runCleanup, "message-bus-registration");
  return () => {
    if (!active) return;
    active = false;
    removeRevoke();
    removeDispose();
    cleanup();
  };
}

/** 创建绑定到指定插件实例的 MessageBus 视图。 */
export function createScopedMessageBus(base: MessageBus, scope: LifecycleScope): MessageBus {
  return {
    publish<TPayload>(type: string, payload: TPayload, options?: PublishOptions): string {
      scope.assertActive();
      return base.publish(type, payload, options);
    },

    subscribe<TPayload>(type: string, handler: (payload: TPayload) => void): () => void {
      scope.assertActive();
      const unsubscribe = base.subscribe<TPayload>(type, (payload) => {
        if (scope.state !== "active") return;
        handler(payload);
      });
      return withScopeCleanup(scope, unsubscribe);
    },

    dispatch<TPayload>(type: string, payload: TPayload, options: DispatchOptions): string {
      scope.assertActive();
      const merged = mergeSignals(scope.signal, options.signal);
      const cleanup = withScopeCleanup(scope, merged.dispose);
      try {
        return base.dispatch(type, payload, {
          ...options,
          signal: merged.signal,
          onSettled: () => {
            cleanup();
            options.onSettled?.();
          },
        });
      } catch (error) {
        cleanup();
        throw error;
      }
    },

    request<TPayload, TResult>(type: string, payload: TPayload, options: RequestOptions): Promise<TResult> {
      scope.assertActive();
      const merged = mergeSignals(scope.signal, options.signal);
      const cleanup = withScopeCleanup(scope, merged.dispose);
      try {
        const request = base.request<TPayload, TResult>(type, payload, {
          ...options,
          signal: merged.signal,
          onSettled: () => {
            cleanup();
            options.onSettled?.();
          },
        });
        return request.finally(cleanup);
      } catch (error) {
        cleanup();
        return Promise.reject(error);
      }
    },

    handle<TPayload, TResult>(
      type: string,
      handler: MessageHandler<TPayload, TResult>,
      options?: HandlerOptions,
    ): () => void {
      scope.assertActive();
      const scopedHandler: MessageHandler<TPayload, TResult> = (message: Message<TPayload>) => {
        if (scope.state !== "active") {
          throw new LifecycleScopeRevokedError(
            `Lifecycle scope "${scope.identity.scopeId}" is ${scope.state}`,
          );
        }
        const merged = mergeSignals(scope.signal, message.signal);
        try {
          const result = handler({ ...message, signal: merged.signal });
          if (result && typeof (result as PromiseLike<TResult>).then === "function") {
            return Promise.resolve(result).finally(merged.dispose) as Promise<TResult>;
          }
          merged.dispose();
          return result;
        } catch (error) {
          merged.dispose();
          throw error;
        }
      };
      const unregister = base.handle(type, scopedHandler, options);
      return withScopeCleanup(scope, unregister);
    },

    snapshot() {
      return base.snapshot();
    },

    onSnapshot(handler) {
      scope.assertActive();
      const unsubscribe = base.onSnapshot(handler);
      return withScopeCleanup(scope, unsubscribe);
    },
  };
}
