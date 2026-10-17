#!/bin/bash
# App scheduling comes later. This only starts one tool's real batch; run.sh inside the release owns repository locks.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
exec node "$here/src/cli.ts" batch "$@"
