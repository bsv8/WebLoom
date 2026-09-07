/**
 * useResource React Hook
 *
 * 设计缘由：负责 ensure + useSyncExternalStore 订阅并返回完整 snapshot。
 * 不暴露 store 内部可变对象。
 */

import { useCallback, useSyncExternalStore } from "react";
import type { ResourceSnapshot } from "../contracts/resource.js";
import type { ResourceStoreApi } from "../resources/resourceStore.js";

/** useResource hook：返回完整资源快照 */
export function useResource<T>(
  store: ResourceStoreApi,
  definitionId: string,
  args: readonly string[]
): ResourceSnapshot<T> {
  const subscribe = useCallback((callback: () => void) => {
    return store.subscribe(definitionId, args, callback);
  }, [store, definitionId, ...args]);

  const getSnapshot = useCallback((): ResourceSnapshot<T> => {
    return store.ensure<T>(definitionId, args);
  }, [store, definitionId, ...args]);

  const getServerSnapshot = useCallback((): ResourceSnapshot<T> => {
    // SSR 稳定快照
    return {
      key: [definitionId, ...args],
      status: "pending",
      data: undefined,
      revision: 0,
    };
  }, [definitionId, ...args]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
