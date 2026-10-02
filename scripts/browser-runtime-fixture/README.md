# Real browser runtime fixture

This fixture is deliberately separate from the Vitest `MessageChannel` transport
simulation. The runner first performs a Vite production build, serves the emitted
dist with `vite preview`, and opens real Window pages that connect to the same
hashed module SharedWorker URL.

The production browser matrix covers the two-page shared-worker/reverse-RPC/stream
path, reconnect and protocol mismatch, terminal disposal, and a `transfer-matrix`
scenario. The matrix exercises RPC request/result and stream request/item
`ArrayBuffer`, shared `Uint8Array` views, business `MessagePort` values, duplicate
and unreachable transfer declarations, pre-send/pre-ready/post-send cancellation,
and the resulting ownership/error assertions.

The separate `pnpm run test:ablation` command runs the temporary-copy AT-22
baseline/mutation/restoration probes for cancel, deadline, service-instance
filtering, directory validation, and synchronous revoke.

`plugin-consumer.html` is a second entry of the same production build (both HTML
files are declared in `vite.config.mjs`). It renders real plugin UI through
`PluginConsumerProvider` and covers dynamic page registration, a static home
contribution, a provider-shared Picker, and the negative cases: undeclared
capability, forged consumer, App hook inside a plugin subtree, and a plugin that
uses the built-in resource registry without declaring it. Its result object
`window.__WEBLOOM_PCB_RESULT__` is asserted by the runner.

The runner must report `unsupported` when Playwright or a Chromium binary is not
available. It must not fall back to Node or a same-page `MessageChannel`.
