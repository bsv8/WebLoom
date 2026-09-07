// 仅用于开发/测试观察组件 render 次数；生产构建中保持 no-op。

const counters = new Map<string, number>();

function enabled(): boolean {
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
  return env?.DEV !== false;
}

export function countRender(name: string): void {
  if (!enabled()) return;
  counters.set(name, (counters.get(name) ?? 0) + 1);
}

export function getRenderCount(name: string): number {
  return counters.get(name) ?? 0;
}

export function resetRenderCounters(): void {
  counters.clear();
}
