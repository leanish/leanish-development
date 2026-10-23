# Copied from leanish/leanish-development agents/bump-it/local/guard/lib.sh at c6282df; see PROVENANCE.md.
# Local changes: messages say "agent guard" (secure-it and bump-it share these); "the handler" is "the tool"; real_bin
# sets `real` without a subshell and skips the guard's own shim by inode.
# Shared by the agent guard shims (sourced, not executed). Guard rails for a
# local scheduled run, not a boundary: the agent could still call the real
# binaries by path, and private repos on GitHub Free have no branch protection.

# This guard's directory as sourced, not resolved: real_bin compares files by inode instead, without a process.
case "${BASH_SOURCE[0]}" in */*) guard_dir=${BASH_SOURCE[0]%/*} ;; *) guard_dir=. ;; esac

deny() {
  echo "agent guard: refused: $*" >&2
  exit 126
}

# Sets `real` to the next executable named $1 on PATH that isn't this guard's own shim (or a link to it). It runs in
# the guard's shell, with no subshell: guarded commands run often (a repository's own tests call git hundreds of
# times), and each process started here adds to every call.
real_bin() {
  local name=$1 dir
  local IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] || continue
    [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ] || continue
    [ "$dir/$name" -ef "$guard_dir/$name" ] && continue
    real="$dir/$name"
    return 0
  done
  echo "agent guard: no real '$name' on PATH" >&2
  exit 127
}
