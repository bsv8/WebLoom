// 绑定插件实例的资源注册表视图（PSM-R07 / PCB-R05）。
//
// 插件通过 ctx.capability(RESOURCE_REGISTRY) 拿到的不是裸全局注册表，而是
// 绑定当前实例的视图：register 时由 Host 把真实 instanceId 写进不可伪造的
// owner 字段，load/subscribe 阶段的能力解析再回到该实例的 consumer。
//
// 查询同样按实例收口：别的插件登记的定义（可能闭包捕获了它的私有实现）既不能
// 通过 get 取到，也不能通过 _ids 列出。可信 Host 保留完整视图用于执行与清理。

import type { ResourceDefinition, ResourceRegistry } from "../contracts/resource.js";
import { UNOWNED_RESOURCE_OWNER } from "./resourceRegistry.js";

/** 宿主资源使用的保留 owner 标识；它不对应任何插件实例。 */
export { UNOWNED_RESOURCE_OWNER };

/** 创建绑定单个实例的资源注册表视图所需的输入。 */
export interface CreateInstanceResourceRegistryInput {
  /** 底层注册表；Host 持有唯一实例。 */
  readonly registry: ResourceRegistry;
  /** 本视图所属的真实运行实例标识。 */
  readonly instanceId: string;
  /** 实例撤销时同步拒绝后续操作。 */
  readonly assertActive: () => void;
  /** 把定义写入底层注册表并绑定 owner。 */
  readonly registerOwned: (instanceId: string, definition: ResourceDefinition<never, readonly string[]>) => void;
  /** 判断该定义是否属于当前实例；用于拒绝注销他人定义与查询他人定义。 */
  readonly isOwnedBy: (definitionId: string, instanceId: string) => boolean;
  /**
   * 读取一个定义所属的真实实例 owner。
   *
   * 宿主内部视图用它做撤销清理与本实例归属判断；插件视图只在“是否属于本实例”的
   * 判断里使用，不对外暴露。
   */
  readonly ownerOf: (definitionId: string) => string | undefined;
  /**
   * 列出属于该实例的资源定义 id。
   *
   * Host 用它在实例撤销时做 owner 条件清理；这是宿主侧的运维读取口，不是
   * 插件的查询能力，因此不放在 ResourceRegistry 公开接口里。
   */
  ownedDefinitionIds?: () => readonly string[];
}

/** 插件可见的实例资源注册表视图；只有公开 ResourceRegistry 成员。 */
export type InstanceResourceRegistryView = ResourceRegistry;

/** 宿主内部视图：额外带 owner 查询，供撤销清理使用，不发给插件。 */
export type HostInstanceResourceRegistryView = InstanceResourceRegistryView & {
  /** 列出属于本实例的定义 id；仅供 Host 撤销清理使用。 */
  ownedDefinitionIds(): readonly string[];
};

/**
 * 创建一个只对当前插件实例开放的资源注册表视图。
 *
 * - `register`：owner 由 Host 绑定，插件无法通过参数伪造他人或 unowned；
 * - `unregister`：只允许注销本实例登记的定义，跨实例注销直接拒绝；
 * - `get` / `_ids`：只返回本实例的定义。别人的定义携带其私有 loader 闭包，
 *   取得它就等于绕过私有实现边界，因此按 undefined 处理而不是静默返回。
 */
export function createInstanceResourceRegistry(input: CreateInstanceResourceRegistryInput): HostInstanceResourceRegistryView {
  const view: HostInstanceResourceRegistryView = {
    register<T, TArgs extends readonly string[]>(definition: ResourceDefinition<T, TArgs>): void {
      input.assertActive();
      input.registerOwned(input.instanceId, definition as unknown as ResourceDefinition<never, readonly string[]>);
    },
    unregister(id: string): void {
      input.assertActive();
      // 跨实例注销必须拒绝，而不是静默删除别人的定义。
      if (!input.isOwnedBy(id, input.instanceId)) {
        throw new Error(`Resource definition "${id}" is not owned by plugin instance "${input.instanceId}"`);
      }
      input.registry.unregister(id);
    },
    get<T, TArgs extends readonly string[]>(id: string): ResourceDefinition<T, TArgs> | undefined {
      input.assertActive();
      // 只暴露本实例的定义：跨实例读取一律按不存在处理。
      if (!input.isOwnedBy(id, input.instanceId)) return undefined;
      return input.registry.get<T, TArgs>(id);
    },
    _ids(): string[] {
      input.assertActive();
      // 只列举本实例的定义 id，不泄露其它插件的注册项。
      const ids = input.registry._ids();
      return ids.filter((id) => input.isOwnedBy(id, input.instanceId));
    },
    ownedDefinitionIds(): readonly string[] {
      return input.ownedDefinitionIds?.() ?? [];
    },
  };
  // 插件拿到的实例视图不含宿主侧 owner 查询能力；撤销清理由 Host 自己
  // 持有的内部记录负责，不通过被冻结的公开对象暴露。
  return Object.freeze(view);
}
