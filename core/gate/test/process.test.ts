import { describe, expect, it } from "vitest";

import { runProcess } from "../src/process.ts";

describe("runProcess", () => {
  it("kills a command that outlives its time limit, reporting the signal as 128", async () => {
    const result = await runProcess("sleep", ["5"], { timeoutMs: 100 });
    expect(result.code).toBe(128);
  });

  it("rejects a command that can't start, without a time limit left running", async () => {
    const handles = () => (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
    const before = handles();
    await expect(runProcess("no-such-command-for-this-test", [], { timeoutMs: 60_000 })).rejects.toThrow("couldn't run no-such-command-for-this-test");
    expect(handles()).toBe(before);
  });
});
