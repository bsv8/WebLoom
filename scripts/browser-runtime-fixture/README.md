# Real browser runtime fixture

This fixture is deliberately separate from the Vitest `MessageChannel` transport
simulation. The runner first performs a Vite production build, serves the emitted
dist with `vite preview`, and opens real Window pages that connect to the same
hashed module SharedWorker URL. It also runs reconnect and protocol-mismatch
scenarios.

The runner must report `unsupported` when Playwright or a Chromium binary is not
available. It must not fall back to Node or a same-page `MessageChannel`.
