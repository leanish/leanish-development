import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.ts";

describe("supply-chain.json", () => {
  it("strips trailing slashes from registries, builds and repositories as before, and a long slash run in linear time", () => {
    const config = parseConfig({
      npm: { registries: ["https://r.example/", "https://r.example///", "https://r.example/a//b/", "https://r.example"] },
      gradle: { builds: ["tools/", "tools//", "./", "a//b"] },
      maven: { repositories: ["https://m.example/maven2/", "https://m.example"] },
    });
    expect(config.npm.registries).toEqual(["https://r.example", "https://r.example", "https://r.example/a//b", "https://r.example"]);
    expect(config.gradle.builds).toEqual(["tools", "tools", ".", "a//b"]);
    expect(config.maven.repositories).toEqual(["https://m.example/maven2", "https://m.example"]);
    const run = `a${"/".repeat(100_000)}b`;
    const started = performance.now();
    // The replaced regex rescanned the run from each slash, for each of the three.
    const long = parseConfig({ npm: { registries: [`https://${run}`] }, gradle: { builds: [run] }, maven: { repositories: [`https://${run}`] } });
    const elapsed = performance.now() - started;
    expect([long.npm.registries, long.gradle.builds, long.maven.repositories]).toEqual([[`https://${run}`], [run], [`https://${run}`]]);
    expect(elapsed).toBeLessThan(2_000);
  });
});
