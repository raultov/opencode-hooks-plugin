import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/v1.ts", "src/v2.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  dts: true,
  outDir: "dist",
  // `@opencode/plugin`'s `Plugin.define` is a three-line identity helper.
  // Inlining it keeps every entry loadable on hosts that never install the V2
  // SDK (opencode V1 does not), at no measurable size cost.
  noExternal: ["@opencode/plugin"],
});
