import { describe, expect, test } from "bun:test";
import moduleDefault, { HooksPlugin, HooksPluginV2 } from "../src/index.js";

describe("dual entrypoint", () => {
  test("serves opencode V2 as a plugin definition", () => {
    expect(moduleDefault.id).toBe("opencode-hooks");
    expect(typeof moduleDefault.setup).toBe("function");
    expect(moduleDefault.setup).toBe(HooksPluginV2.setup);
  });

  test("serves opencode V1 as a PluginModule", () => {
    expect(typeof moduleDefault.server).toBe("function");
    expect(moduleDefault.server).toBe(HooksPlugin);
    expect(moduleDefault.tui).toBeUndefined();
  });
});
