import { describe, expect, it } from "vitest";

import { NpmGraph } from "../src/npm-graph.ts";
import { repositoryOverrides } from "../src/npm-overrides.ts";
import { retentionManifests } from "../src/npm-pins.ts";

describe("retention under shared overrides", () => {
  it.each([
    { version: "1.9.0", target: "1.9.0", pinnable: true },
    { version: "2.0.0", target: "2.0.0", pinnable: false },
    { version: "2.0.0", target: "1.9.0", pinnable: true },
    { version: "1.9.0", target: "2.0.0", pinnable: false },
    { version: "2.0.0", target: undefined, pinnable: false },
  ])("checks other copies' targets or unpinned versions ($version → $target)", ({ version, target, pinnable }) => {
    const root = { dependencies: { parent: "^1", other: "^1" }, overrides: { held: "^1 || ^2" } };
    const graph = new NpmGraph({ packages: {
      "": root,
      "node_modules/parent": { version: "1.0.0", dependencies: { held: "^1" } },
      "node_modules/parent/node_modules/held": { version: "1.9.0" },
      "node_modules/other": { version: "1.0.0", dependencies: { held: "^1 || ^2" } },
      "node_modules/other/node_modules/held": { version },
    } });
    const held = graph.copies().find((copy) => copy.path === "node_modules/parent/node_modules/held")!;
    const other = graph.copies().find((copy) => copy.path === "node_modules/other/node_modules/held")!;
    const pins = [{ copy: held, target: "1.9.0" }, ...(target === undefined ? [] : [{ copy: other, target }])];
    const result = retentionManifests(graph, pins, new Map([[held.path, held]]), new Map([["", root]]), repositoryOverrides(root));
    expect([...result.unpinned]).toEqual(pinnable ? [] : [held.path]);
    expect((result.manifests.get("") ?? root).overrides).toEqual({ held: pinnable ? "1.9.0" : target ?? "^1 || ^2" });
  });
});
