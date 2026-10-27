// A tool command whose run waits to be killed, with fakes for everything outside: argv[2] is run.sh's marker file.
import { InMemoryWorkspace } from "@leanish/agent-runtime/working-copy/in-memory-workspace";
import { FakeCodingAgentRunner } from "@leanish/agent-runtime/skill/fake-runner";
import { runToolCommand } from "../../src/command.ts";

const CONFIG = `
repos: [{ repo: leanish/widget, branch: main }]
agent: { codingAgent: codex, model: sol, effort: medium }
secrets: { write: w, read: r }
commitIdentity: { name: leanish, email: leanish@example.com }
dirs: { state: /tmp/tool-state, cache: /tmp/tool-cache }
`;

process.exitCode = await runToolCommand(
  {
    tool: "secure-it",
    skills: { dirs: ["/nonexistent"], entrypoints: [], support: [] },
    run: async (context) => {
      await context.fetch("https://api.github.com/repos/source/lib/security-advisories");
      process.stderr.write("waiting to be killed\n");
      await new Promise((settle) => setTimeout(settle, 30_000));
      return {};
    },
    review: async () => ({}),
  },
  ["run", "leanish/widget", "--config", "/config.yaml"],
  {
    fetch: async () => new Response("[]"),
    secrets: { get: async (name) => `${name}-token` },
    readText: async () => CONFIG,
    ensureDir: async () => {},
    workspace: () => new InMemoryWorkspace(),
    runner: () => new FakeCodingAgentRunner("codex"),
    reportEnv: { TOOL_REPORT_MARKER: process.argv[2] },
  },
);
