/**
 * useResourceSelector React Hook
 *
 * 设计缘由：只在 selector 结果发生语义变化时重渲染。
 * selector 和 equality 必须为纯函数。
 */

import { useSyncExternalStore, useCallback, useRef } from "react";
import type { ResourceSnapshot } from "../contracts/resource.js";
import type { ResourceStoreApi } from "../resources/resourceStore.js";

/** 默认相等判断：Object.is */
function defaultEquality<T>(a: T, b: T): boolean {
  return Object.is(a, b);
}

/** useResourceSelector hook：只在 selector 结果变化时重渲染 */
export function useResourceSelector<T, TSelected>(
  store: ResourceStoreApi,
  definitionId: string,
  args: readonly string[],
  selector: (snapshot: ResourceSnapshot<T>) => TSelected,
  equality: (a: TSelected, b: TSelected) => boolean = defaultEquality
): TSelected {
  const selectedRef = useRef<TSelected>();
  const hasSelectedRef = useRef(false);
  const sourceSnapshotRef = useRef<ResourceSnapshot<T>>();
  const selectorRef = useRef(selector);
  const equalityRef = useRef(equality);

  // 更新 refs
  selectorRef.current = selector;
  equalityRef.current = equality;

  const subscribe = useCallback(
    (callback: () => void) => {
      return store.subscribe(definitionId, args, callback);
    },
    [store, definitionId, ...args]
  );

  const getSnapshot = useCallback((): TSelected => {
    const snapshot = store.ensure<T>(definitionId, args);

    // React's useSyncExternalStore requires referentially stable results when
    // the backing store did not change. A selector may legitimately allocate
    // (for example `rows.slice().sort(...)`), so equality alone cannot uphold
    // that requirement when callers use reference equality.
    if (hasSelectedRef.current && sourceSnapshotRef.current === snapshot) {
      return selectedRef.current as TSelected;
    }

    const selected = selectorRef.current(snapshot);

    // 检查是否变化
    if (
      hasSelectedRef.current &&
      equalityRef.current(selectedRef.current as TSelected, selected)
    ) {
      sourceSnapshotRef.current = snapshot;
      return selectedRef.current as TSelected;
    }

    selectedRef.current = selected as TSelected;
    hasSelectedRef.current = true;
    sourceSnapshotRef.current = snapshot;
    return selected;
  }, [store, definitionId, ...args]);

  const getServerSnapshot = useCallback((): TSelected => {
    const snapshot: ResourceSnapshot<T> = {
      key: [definitionId, ...args],
      status: "pending",
      data: undefined,
      revision: 0,
    };
    return selectorRef.current(snapshot);
  }, [definitionId, ...args]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
