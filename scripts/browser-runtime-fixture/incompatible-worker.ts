const scope = globalThis as unknown as {
  onconnect: ((event: { ports: MessagePort[] }) => void) | null;
};

scope.onconnect = (event) => {
  const port = event.ports[0];
  if (!port) return;
  port.postMessage({
    type: "webloom.runtime.snapshot",
    protocolVersion: "webloom.runtime.v0",
    runtimeId: "browser-fixture-runtime",
    runtimeKind: "shared-worker",
    runtimeInstanceId: "incompatible:1",
    revision: 0,
    state: "ready",
    units: [],
    services: [],
  });
  port.start();
};
