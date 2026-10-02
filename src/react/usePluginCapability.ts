// 插件实例能力 hook（PCB-R03）。
//
// 这些 hook 只通过 PluginConsumer 读取能力，因此自带“已声明 + 实例有效”
// 的双重约束：optional/has 只会对“已声明但暂时缺席”返回 undefined，
// 未声明、版本不匹配或实例撤销仍然抛错，不会被吞掉。

import { useCallback, useSyncExternalStore } from "react";
import type { Capability, CapabilityClient } from "../contracts/capability.js";
import { usePluginConsumer } from "./PluginConsumerProvider.js";

/** 按当前插件实例读取已声明的 typed 能力。 */
export function usePluginCapability<C extends Capability>(capability: C): CapabilityClient<C> {
  const consumer = usePluginConsumer();
  const subscribe = useCallback((listener: () => void) => consumer.subscribe(listener), [consumer]);
  const getSnapshot = useCallback(
    () => (consumer.capability as <T extends Capability>(input: T) => CapabilityClient<T>)(capability),
    [consumer, capability],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 按当前插件实例读取可选能力；已声明但缺席时返回 undefined。 */
export function useOptionalPluginCapability<C extends Capability>(capability: C): CapabilityClient<C> | undefined {
  const consumer = usePluginConsumer();
  const subscribe = useCallback((listener: () => void) => consumer.subscribe(listener), [consumer]);
  const getSnapshot = useCallback(
    () => (consumer.optionalCapability as <T extends Capability>(input: T) => CapabilityClient<T> | undefined)(capability),
    [consumer, capability],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 探测当前插件实例是否已声明且可用某能力；同样不吞掉未声明错误。 */
export function useHasPluginCapability<C extends Capability>(capability: C): boolean {
  return useOptionalPluginCapability(capability) !== undefined;
}
