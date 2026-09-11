import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    advanced: "src/advanced.ts",
    react: "src/react.ts",
    testing: "src/testing.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  outDir: "dist",
  external: ["react", "react-dom"],
});
