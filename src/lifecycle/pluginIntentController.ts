// 插件产品启停控制面。
//
// 这里处理“用户意图已持久化”和“运行实例已经启动”之间的边界：
// - 命令是绝对 desiredEnabled，不使用 toggle；
// - 同一个 authority 内按 commandId 去重；
// - 先查去重，再查 expectedRevision；
// - 只有持久化成功后才发布 accepted。
//
// 它不直接启停 PluginHost。Host / Coordinator 订阅成功后的意图快照，再按
// 依赖图装配运行实例；因此启动失败不会把用户意图偷偷改回 false。

import type {
  PluginIntentCommand,
  PluginIntentCommandResult,
  PluginIntentController,
  PluginIntentSnapshot,
} from "../contracts/lifecycle.js";

export interface CreatePluginIntentControllerOptions {
  /** 当前控制面启动身份；Worker 重启时应传入新值。 */
  authorityInstanceId?: string;
  /** Worker 恢复后读取的平台意图。 */
  initial?: Partial<PluginIntentSnapshot>;
  /** 将候选快照原子写入平台存储；缺省表示内存控制面（测试用）。 */
  persist?: (snapshot: PluginIntentSnapshot) => Promise<void>;
  /** 有界去重记录数量，避免 commandId 永久增长。 */
  maxCommandRecords?: number;
}

interface CommandRecord {
  fingerprint: string;
  result: Extract<PluginIntentCommandResult, { status: "accepted" | "duplicate" }>;
}

function makeAuthorityInstanceId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `authority:${crypto.randomUUID()}`;
    }
  } catch {
    // 非安全唯一值只作本次 Worker 运行身份，不能作为权限凭据。
  }
  return `authority:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function cloneSnapshot(snapshot: PluginIntentSnapshot): PluginIntentSnapshot {
  return {
    revision: snapshot.revision,
    desiredEnabled: { ...snapshot.desiredEnabled },
    desiredRevision: { ...snapshot.desiredRevision },
  };
}

function normalizeSnapshot(initial: Partial<PluginIntentSnapshot> | undefined): PluginIntentSnapshot {
  const revision = Number.isSafeInteger(initial?.revision) && (initial?.revision ?? 0) >= 0
    ? initial!.revision!
    : 0;
  const desiredEnabled: Record<string, boolean> = {};
  for (const [pluginId, value] of Object.entries(initial?.desiredEnabled ?? {})) {
    if (typeof value === "boolean") desiredEnabled[pluginId] = value;
  }
  const desiredRevision: Record<string, number> = {};
  for (const [pluginId, value] of Object.entries(initial?.desiredRevision ?? {})) {
    if (Number.isSafeInteger(value) && value >= 0) desiredRevision[pluginId] = value;
  }
  return { revision, desiredEnabled, desiredRevision };
}

function commandFingerprint(command: PluginIntentCommand): string {
  return [
    command.authorityInstanceId,
    command.expectedRevision,
    command.pluginId,
    command.desiredEnabled ? "true" : "false",
  ].join("\u0000");
}

function commandError(message: string): Extract<PluginIntentCommandResult, { status: "command-conflict" }> {
  return { status: "command-conflict", commandId: "", message };
}

/** 创建单一控制面上的插件意图控制器。 */
export function createPluginIntentController(
  options: CreatePluginIntentControllerOptions = {}
): PluginIntentController {
  const authorityInstanceId = options.authorityInstanceId ?? makeAuthorityInstanceId();
  const maxCommandRecords = Math.max(1, Math.floor(options.maxCommandRecords ?? 256));
  let current = normalizeSnapshot(options.initial);
  const commandRecords = new Map<string, CommandRecord>();
  const listeners = new Set<(snapshot: PluginIntentSnapshot) => void>();
  let queue = Promise.resolve();

  const notify = () => {
    const snapshot = cloneSnapshot(current);
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // UI 观察者错误不能回滚已经成功持久化的意图。
      }
    }
  };

  const process = async (command: PluginIntentCommand): Promise<PluginIntentCommandResult> => {
    const candidate = command as Partial<PluginIntentCommand> | null | undefined;
    const commandId = typeof candidate?.commandId === "string" ? candidate.commandId : "";
    if (
      !candidate
      || typeof candidate.authorityInstanceId !== "string"
      || candidate.authorityInstanceId.length === 0
      || typeof candidate.pluginId !== "string"
      || candidate.pluginId.length === 0
      || typeof candidate.desiredEnabled !== "boolean"
      || !Number.isSafeInteger(candidate.expectedRevision)
      || (candidate.expectedRevision ?? -1) < 0
      || commandId.length === 0
    ) {
      const result = commandError("commandId、pluginId 和 expectedRevision 必须是有效值");
      return { ...result, commandId };
    }
    if (command.authorityInstanceId !== authorityInstanceId) {
      return {
        status: "stale-authority",
        commandId: command.commandId,
        expectedAuthorityInstanceId: authorityInstanceId,
      };
    }

    const fingerprint = commandFingerprint(command);
    const existing = commandRecords.get(command.commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return {
          status: "command-conflict",
          commandId: command.commandId,
          message: "相同 commandId 的命令内容不同，拒绝覆盖原命令",
        };
      }
      return {
        status: "duplicate",
        commandId: command.commandId,
        snapshot: cloneSnapshot(existing.result.snapshot),
        persisted: true,
      };
    }

    if (command.expectedRevision !== current.revision) {
      return {
        status: "revision-conflict",
        commandId: command.commandId,
        snapshot: cloneSnapshot(current),
      };
    }

    const next: PluginIntentSnapshot = {
      revision: current.revision + 1,
      desiredEnabled: {
        ...current.desiredEnabled,
        [command.pluginId]: command.desiredEnabled,
      },
      desiredRevision: {
        ...current.desiredRevision,
        [command.pluginId]: (current.desiredRevision[command.pluginId] ?? 0) + 1,
      },
    };
    try {
      await options.persist?.(cloneSnapshot(next));
    } catch (error) {
      return {
        status: "persistence-failed",
        commandId: command.commandId,
        message: error instanceof Error ? error.message : String(error),
        snapshot: cloneSnapshot(current),
      };
    }

    current = next;
    const accepted: Extract<PluginIntentCommandResult, { status: "accepted" | "duplicate" }> = {
      status: "accepted",
      commandId: command.commandId,
      snapshot: cloneSnapshot(current),
      persisted: true,
    };
    commandRecords.set(command.commandId, {
      fingerprint,
      result: accepted,
    });
    while (commandRecords.size > maxCommandRecords) {
      const oldest = commandRecords.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      commandRecords.delete(oldest);
    }
    notify();
    return {
      status: "accepted",
      commandId: accepted.commandId,
      snapshot: cloneSnapshot(accepted.snapshot),
      persisted: true,
    };
  };

  const controller: PluginIntentController = {
    authorityInstanceId,
    snapshot: () => cloneSnapshot(current),
    submit(command) {
      const result = queue.then(() => process(command));
      // 无论上一条命令结果如何，后续命令都必须继续进入同一串行队列。
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return controller;
}
