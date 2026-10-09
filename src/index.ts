import type { PluginModule as V1PluginModule } from "@opencode-ai/plugin";
import { HooksPlugin } from "./v1.js";
import { type createHooksPluginV2, HooksPluginV2 } from "./v2.js";

export type { Bridge, CommandResult, Exec, HooksPluginOptions, Log, LogLevel } from "./bridge.js";
export type { Control, Directive } from "./control.js";
export type { HookEntry, HooksFile, MatcherGroup, ResolvedCommand } from "./hooks-file.js";
export { HooksPlugin } from "./v1.js";
export type { HooksPluginV2Dependencies } from "./v2.js";
export { createHooksPluginV2, HooksPluginV2 } from "./v2.js";

/**
 * Dual entrypoint, one package for both opencode generations.
 *
 * opencode V2 reads the default export as a plugin definition (`id` + `setup`)
 * and calls `setup`. opencode V1 (1.18.29 and newer) reads it as a
 * `PluginModule` and calls `server` with the classic `(input, options)`
 * signature. Both implementations share `bridge.ts`, so the bridged behaviour
 * cannot drift between generations.
 *
 * V1 releases older than 1.18.29 cannot load an object entrypoint: stay on
 * `@raultov/opencode-hooks-plugin@0.2.0` there.
 */
const HooksPluginModule: V1PluginModule & ReturnType<typeof createHooksPluginV2> = {
  ...HooksPluginV2,
  server: HooksPlugin,
};

export default HooksPluginModule;
