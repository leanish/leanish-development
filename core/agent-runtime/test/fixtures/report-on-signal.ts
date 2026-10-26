// New in this repository, for run-report.test.ts.
// A command that reports on termination signals, then waits to be killed: `in-flight` leaves one skill run started,
// `extra` adds a host field counted after reporting started.
import { reportOnTerminationSignals, RunReport } from "../../src/report/run-report.ts";

const report = new RunReport();
report.identified({ tool: "secure-it", repo: "acme/widget" });
let dispatches = 0;
reportOnTerminationSignals(report, process.stderr, process.argv[2] === "extra" ? () => ({ dispatches }) : undefined);
dispatches += 1;
if (process.argv[2] === "in-flight") report.usageRecorder.started?.({ invocationId: "i-1", entrypoint: "secure-it" });
process.stderr.write("ready\n");
setTimeout(() => undefined, 30_000);
