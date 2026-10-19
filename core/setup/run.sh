#!/bin/bash
# The command run by a local app's scheduled task: one tool's real batch; the release runtime owns repository locks.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
# Start from the release root, never the caller's folder: a scheduled task's own folder is writable by the app's
# agent, and the tools and the coding agents they start may read configuration relative to the working directory.
cd "$here/../.."
exec node "$here/src/cli.ts" batch "$@"
