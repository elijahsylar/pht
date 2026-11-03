# shellcheck shell=bash
# Sourced by both deploy scripts. Not executable on its own.
#
# require_deployable_main <repo-dir>
#
# Succeeds only when the repo is on `main`, the working tree is clean
# (untracked files included), and HEAD is exactly origin/main after a fetch.
# Otherwise prints why and returns 1. There is deliberately no override: what
# gets deployed must be what is on GitHub's main, so the release on the server
# can always be traced to a pushed commit, and a feature branch or a half-edited
# tree can never reach production. Scripts run straight from the working tree
# follow whatever branch is checked out, which is how a branch would otherwise
# slip through.
require_deployable_main() {
  local dir="$1" branch dirty head remote
  branch="$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null)" || {
    printf '[GUARD] %s: detached HEAD — check out main\n' "$dir" >&2
    return 1
  }
  if [[ "$branch" != "main" ]]; then
    printf "[GUARD] %s is on branch '%s' — deploys only run from main\n" "$dir" "$branch" >&2
    return 1
  fi
  dirty="$(git -C "$dir" status --porcelain --untracked-files=normal)"
  if [[ -n "$dirty" ]]; then
    printf '[GUARD] %s has uncommitted or untracked changes — commit or stash them:\n%s\n' \
      "$dir" "$dirty" >&2
    return 1
  fi
  git -C "$dir" fetch --quiet origin main || {
    printf '[GUARD] %s: git fetch origin main failed — cannot prove HEAD matches GitHub\n' "$dir" >&2
    return 1
  }
  head="$(git -C "$dir" rev-parse HEAD)"
  remote="$(git -C "$dir" rev-parse origin/main)"
  if [[ "$head" != "$remote" ]]; then
    printf '[GUARD] %s: HEAD %s is not origin/main %s — push or pull until they match\n' \
      "$dir" "${head:0:7}" "${remote:0:7}" >&2
    return 1
  fi
  return 0
}
