#!/usr/bin/env node
/**
 * secure-it run|review <owner/repo> [--config <agent.yaml>]: `run` fixes one
 * package the supply-chain gate's full scan fails on (every malicious package
 * together) and opens or updates its PR; `review` goes over secure-it's open
 * PRs (see core/tool-runtime). Usually started by `core/tool-runtime/run.sh`.
 */
import { runToolCommand } from "@leanish/tool-runtime/command";

import { secureIt } from "./secure-it.ts";

process.exitCode = await runToolCommand(secureIt(), process.argv.slice(2));
