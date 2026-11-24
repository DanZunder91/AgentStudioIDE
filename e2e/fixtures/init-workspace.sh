#!/bin/sh
# Turn the E2E fixture workspace into a self-contained git repo (seam S8).
#
# `find_repo_root` walks up to the first `.git`; the fixture needs its OWN so the
# app roots there and not in the outer Agent Studio repo. The `.git` is not (and
# cannot be) committed, so this seeds it. Idempotent: a no-op if `.git` exists.
#
# `wdio.conf.ts` `onPrepare` runs the equivalent inline (cross-platform) before
# any session; this script is the manual/local + CI convenience form.
set -eu

dir="$(CDPATH= cd -- "$(dirname -- "$0")/workspace" && pwd)"

if [ -d "$dir/.git" ]; then
  echo "fixture workspace already a git repo: $dir"
  exit 0
fi

git -C "$dir" init -q
# A deterministic identity so the commit never depends on the runner's git config.
git -C "$dir" -c user.name="e2e" -c user.email="e2e@agentstudio.test" add -A
git -C "$dir" -c user.name="e2e" -c user.email="e2e@agentstudio.test" \
  commit -q -m "e2e fixture workspace"
echo "seeded fixture git repo: $dir"
