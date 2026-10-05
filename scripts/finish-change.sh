#!/usr/bin/env bash
# Usage: scripts/finish-change.sh <change-name> "<one-line summary>"
#
# The human's signature on checkpoint 3. Archives the OpenSpec change (its spec
# changes become the living specs) and saves all the work in git as one commit.
# opencode asks for permission every time an agent runs it.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

change="${1:-}"
summary="${2:-}"
if [ -z "$change" ] || [ -z "$summary" ]; then
  die "usage: scripts/finish-change.sh <change-name> \"<one-line summary>\""
fi
[ -d "openspec/changes/$change" ] || die "no active change at openspec/changes/$change"
scripts/check-test-lock.sh > /dev/null ||
  die "the acceptance test lock does not match - run scripts/verify.sh $change first"

echo "==> Archiving $change"
openspec archive "$change" --yes

if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "==> Saving the work in git"
  git add -A
  if git diff --cached --quiet; then
    echo "Nothing new to save."
  else
    git commit -q -m "$change: $summary" ||
      die "git could not save - set your name and email once: git config --global user.name \"Your Name\" && git config --global user.email you@example.com"
    echo "Saved: $(git log -1 --format='%h %s')"
  fi
else
  echo "This folder is not a git repository, so the work is archived but not saved in version control."
fi
