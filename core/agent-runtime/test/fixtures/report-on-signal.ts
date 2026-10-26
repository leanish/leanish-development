// New in this repository, for run-report.test.ts.
// A command that reports on termination signals, then waits to be killed: `in-flight` leaves one skill run started,
// `extra` adds a host field counted after reporting started, `bad-extra` one with a reserved name.
import { reportOnTerminationSignals, RunReport } from "../../src/report/run-report.ts";

const report = new RunReport();
report.identified({ tool: "secure-it", repo: "acme/widget" });
let dispatches = 0;
const extras = { extra: () => ({ dispatches }), "bad-extra": () => ({ status: "fine" }) } as const;
reportOnTerminationSignals(report, process.stderr, extras[process.argv[2] as keyof typeof extras]);
dispatches += 1;
if (process.argv[2] === "in-flight") report.usageRecorder.started?.({ invocationId: "i-1", entrypoint: "secure-it" });
process.stderr.write("ready\n");
setTimeout(() => undefined, 30_000);
