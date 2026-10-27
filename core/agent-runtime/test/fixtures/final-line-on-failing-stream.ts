// New in this repository, for run-report.test.ts.
// Writes the final line to a stream whose writes fail with EPIPE and whose destroy takes 50 ms, so its 'error' comes
// well after the write's callback (later than any setImmediate); nothing of this command listens for it. `end` ends a
// startRunReport (its marker after the final line, named in TEST_REPORT_MARKER), `no-close` the same on a stream that
// never emits 'close', `write-final-line` writes with writeFinalLine; each then sets the exit code it means. `signal`
// waits for a SIGTERM instead.
import { Writable } from "node:stream";

import { RunReport, startRunReport, writeFinalLine } from "../../src/report/run-report.ts";

const mode = process.argv[2];
const stream = new Writable({
  emitClose: mode !== "no-close",
  write: (_chunk, _encoding, callback) => callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
  destroy: (err, callback) => {
    setTimeout(() => {
      process.stdout.write("destroyed\n");
      callback(err);
    }, 50);
  },
});

if (mode === "write-final-line") {
  const line = new RunReport().finish({ status: "ok", exitCode: 0 });
  if (line === undefined) throw new Error("no line");
  await writeFinalLine(stream, line);
  process.stdout.write("settled\n");
  process.exitCode = 0;
} else {
  const report = startRunReport({ stream, marker: { env: "TEST_REPORT_MARKER", when: "after-final-line" } });
  if (mode === "signal") {
    process.stdout.write("ready\n");
    setTimeout(() => undefined, 30_000);
  } else {
    const end = { status: "ok", exitCode: 0 } as const;
    await report.end(end);
    process.stdout.write("settled\n");
    process.exitCode = end.exitCode;
  }
}
