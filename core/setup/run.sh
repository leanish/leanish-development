#!/bin/bash
# The command run by a local app's scheduled task: one tool's real batch; the release runtime owns repository locks.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
exec node "$here/src/cli.ts" batch "$@"
