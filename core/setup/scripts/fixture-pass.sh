#!/bin/bash
# One release-candidate fixture pass with a chosen coding agent (docs/releasing.md runs it once per adapter): clean
# the fixture repositories, then run secure-it and bump-it on them with `batch --release`. Both read the owner's
# installation configs, which must list only fixture repositories (`fixture-cleanup` refuses anything else, before
# deleting a branch), so the pass cleans exactly the repositories it runs on. For the pass their `agent:` section is
# switched to the requested agent, model and effort, and the originals are restored on any exit. Nothing else in the
# configs changes, and nothing is written to Git.
#
#   fixture-pass.sh --release <tag> --owner <owner> --agent <claude-code|codex> --model <model> --effort <effort> --out <directory>
#
# Run it with the tools idle and nothing else writing those configs (a restore would undo the change); from any
# directory; Java and the other tools come from the caller's environment. The release must be installed first
# (`node core/setup/src/cli.ts release --candidate <tag>` for a candidate); the pass checks that before it changes anything.
set -u
set -o pipefail

usage() { echo "usage: $0 --release <tag> --owner <owner> --agent <claude-code|codex> --model <model> --effort <effort> --out <directory>" >&2; exit 2; }

RELEASE='' OWNER='' AGENT='' MODEL='' EFFORT='' OUT=''
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case $1 in
    --release) RELEASE=$2 ;;
    --owner) OWNER=$2 ;;
    --agent) AGENT=$2 ;;
    --model) MODEL=$2 ;;
    --effort) EFFORT=$2 ;;
    --out) OUT=$2 ;;
    *) usage ;;
  esac
  shift 2
done
for value in "$RELEASE" "$OWNER" "$AGENT" "$MODEL" "$EFFORT" "$OUT"; do
  [ -n "$value" ] || usage
done
case $AGENT in claude-code | codex) ;; *) echo "--agent must be claude-code or codex" >&2; exit 2 ;; esac
# Only plain characters, since the tag is echoed in messages; setup's isReleaseTag checks it exactly.
[[ $RELEASE =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || { echo "--release takes a vX.Y.Z or vX.Y.Z-rc.N tag" >&2; exit 2; }
# The three values are written into YAML as plain scalars.
for value in "$MODEL" "$EFFORT"; do
  [[ $value =~ ^[A-Za-z0-9._-]+$ ]] || { echo "--model and --effort take letters, digits, '.', '_' and '-' only" >&2; exit 2; }
done

# The same owner rule as the setup CLI (core/setup/src/tools.ts ownerName), lowercased like its installation paths.
[[ $OWNER =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$ ]] || { echo "--owner isn't a GitHub owner or login" >&2; exit 2; }
OWNER=$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')

ROOT=$(cd "$(dirname "$0")/../../.." && pwd) || exit 1
CLI=("node" "$ROOT/core/setup/src/cli.ts")
# batch refuses a release that isn't installed, but only after the cleanup has deleted the fixtures' branches.
node --input-type=module -e '
  const { pathToFileURL } = await import("node:url");
  try { await (await import(pathToFileURL(process.argv[1]).href)).readInstalledRelease(process.argv[2]); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
' "$ROOT/core/setup/src/release.ts" "$RELEASE" || {
  # `release --candidate` takes only candidate tags; plain `release` installs the newest stable release.
  case $RELEASE in
    *-rc.*) echo "$RELEASE didn't verify as installed (above); 'node $ROOT/core/setup/src/cli.ts release --candidate $RELEASE' installs it" >&2 ;;
    *) echo "$RELEASE didn't verify as installed (above); 'node $ROOT/core/setup/src/cli.ts release' installs the newest stable release" >&2 ;;
  esac
  exit 1
}
INSTALLATION="$HOME/.config/leanish/installations/$OWNER"
TOOLS=(bump-it secure-it)
umask 077
mkdir -p "$OUT" || exit 1
STATUS="$OUT/$AGENT.status"

# The backup sits next to its config, whatever --out is: one left by a pass that was killed (SIGKILL skips the
# restore) holds the real config, so a later pass refuses rather than back up the switched one over it.
backup() { printf '%s' "$INSTALLATION/$1/agent.yaml.fixture-pass"; }
for tool in "${TOOLS[@]}"; do
  if [ -e "$(backup "$tool")" ]; then
    echo "$(backup "$tool") exists: a previous pass didn't restore it; copy it over $INSTALLATION/$tool/agent.yaml and delete it first" >&2
    exit 1
  fi
done
for tool in "${TOOLS[@]}"; do
  cp "$INSTALLATION/$tool/agent.yaml" "$(backup "$tool")" && chmod 600 "$(backup "$tool")" || exit 1
done

restored=false
restore() {
  "$restored" && return
  restored=true
  local failed=''
  for tool in "${TOOLS[@]}"; do
    [ -e "$(backup "$tool")" ] || continue
    # cat into the existing file keeps its inode and mode; the backup goes only once it's back.
    if cat "$(backup "$tool")" > "$INSTALLATION/$tool/agent.yaml"; then rm "$(backup "$tool")"; else failed="$failed $tool"; fi
  done
  if [ -z "$failed" ]; then
    echo "configs restored" >> "$STATUS"
  else
    echo "restore FAILED for$failed: copy $INSTALLATION/<tool>/agent.yaml.fixture-pass back by hand" | tee -a "$STATUS" >&2
    exit 1
  fi
}
# An interrupted pass still restores: INT and TERM exit, which runs the EXIT trap. Bash runs a trap only once the
# foreground command ends, so a TERM during a batch restores after it; Ctrl-C stops the batch too.
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Rewrites the top-level `agent:` section: its direct codingAgent, model and effort keys are replaced by the requested
# ones right after `agent:`, at the section's own indentation (two spaces when it has no key yet); any other key in
# the section and every other section stay as they are. The file is read twice: the first pass finds that indentation.
switch_agent() {
  awk -v agent="$AGENT" -v model="$MODEL" -v effort="$EFFORT" '
    FNR == NR {
      if (/^agent:[[:space:]]*$/) { section = 1; next }
      if (/^[^[:space:]#]/) section = 0
      if (section && indent == "" && /^[[:space:]]+[^[:space:]#]/) { match($0, /^[[:space:]]+/); indent = substr($0, 1, RLENGTH) }
      next
    }
    FNR == 1 && indent == "" { indent = "  " }
    /^agent:[[:space:]]*$/ {
      print; print indent "codingAgent: " agent; print indent "model: " model; print indent "effort: " effort
      inside = 1; found = 1; next
    }
    /^[^[:space:]#]/ { inside = 0 }
    inside && index($0, indent) == 1 && substr($0, length(indent) + 1) ~ /^(codingAgent|model|effort):/ { next }
    { print }
    END { if (!found) exit 1 }
  ' "$1" "$1"
}
for tool in "${TOOLS[@]}"; do
  switched=$(switch_agent "$INSTALLATION/$tool/agent.yaml") || { echo "$tool: no top-level agent: section in its config" >&2; exit 1; }
  printf '%s\n' "$switched" > "$INSTALLATION/$tool/agent.yaml" || exit 1
done
echo "$AGENT ($MODEL, $EFFORT) on $RELEASE" > "$STATUS"

CONFIGS=(--bump-it-config "$INSTALLATION/bump-it/agent.yaml" --secure-it-config "$INSTALLATION/secure-it/agent.yaml")
"${CLI[@]}" fixture-cleanup "${CONFIGS[@]}" > "$OUT/$AGENT-cleanup-list.txt" 2>&1
listing=$?
echo "cleanup list rc=$listing" >> "$STATUS"
# 2 is setup's "needs confirmation": branches to delete. Anything else but 0 (blocked, refused) stops before deleting.
[ "$listing" -eq 0 ] || [ "$listing" -eq 2 ] || exit 1
"${CLI[@]}" fixture-cleanup "${CONFIGS[@]}" --apply > "$OUT/$AGENT-cleanup-apply.txt" 2>&1
cleanup=$?
echo "cleanup rc=$cleanup" >> "$STATUS"
[ "$cleanup" -eq 0 ] || exit 1
# GitHub closes the deleted branches' PRs asynchronously; starting at once raced the reviews on 0.8.0 rc.2.
sleep 90
result=0
for tool in secure-it bump-it; do
  "${CLI[@]}" batch "$tool" --owner "$OWNER" --release "$RELEASE" > "$OUT/$AGENT-batch-$tool.json" 2> "$OUT/$AGENT-batch-$tool.err"
  rc=$?
  echo "$tool rc=$rc" >> "$STATUS"
  [ "$rc" -eq 0 ] || result=1
done
exit "$result"
