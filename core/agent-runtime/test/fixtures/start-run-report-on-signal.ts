// New in this repository, for run-report.test.ts.
// A command whose report startRunReport owns, waiting to be killed: its marker (after the final line) is named in
// TEST_REPORT_MARKER; `extra` counts a dispatch made after reporting started, and a line goes before the final one.
// `throwing-extra` and `throwing-before` make those callbacks throw instead.
import { startRunReport } from "../../src/report/run-report.ts";

const mode = process.argv[2];
let dispatches = 0;
const report = startRunReport({
  stream: process.stderr,
  marker: { env: "TEST_REPORT_MARKER", when: "after-final-line" },
  extra: mode === "throwing-extra" ? () => { throw new Error("no counts"); } : () => ({ dispatches }),
  beforeFinalLine: mode === "throwing-before"
    ? () => { throw new Error("no summary"); }
    : (final) => [JSON.stringify({ msg: "before the final line", status: final.status })],
});
report.identified({ agent: "atc" });
dispatches += 1;
process.stderr.write("ready\n");
setTimeout(() => undefined, 30_000);
