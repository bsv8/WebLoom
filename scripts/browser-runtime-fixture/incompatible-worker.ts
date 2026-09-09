const scope = globalThis as unknown as {
  onconnect: ((event: { ports: MessagePort[] }) => void) | null;
};

scope.onconnect = (event) => {
  const port = event.ports[0];
  if (!port) return;
  port.addEventListener("message", (message) => {
    if (message.data?.type !== "webloom.runtime.hello") return;
    port.postMessage({
      type: "webloom.runtime.error",
      protocolVersion: "webloom.runtime.v0",
      code: "runtime.protocol_mismatch",
      message: "Browser fixture intentionally uses an incompatible protocol",
      phase: "handshake",
    });
  });
  port.start();
};
