#!/usr/bin/env node
/** Usually started by core/tool-runtime/run.sh: weekly run, review every few hours. */
import { runToolCommand } from "@leanish/tool-runtime/command";
import { bumpIt } from "./bump-it.ts";

process.exitCode = await runToolCommand(bumpIt(), process.argv.slice(2));
