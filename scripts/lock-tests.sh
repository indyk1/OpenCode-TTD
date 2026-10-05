#!/usr/bin/env bash
# Usage: scripts/lock-tests.sh [change-name]
#
# Records a SHA-256 hash of every acceptance test file and every slice contract
# (*.Contracts.cs) in .workflow/acceptance.lock.
#
# Running this is the human's signature on checkpoint 2: only run it after the
# human approved the tests. opencode asks for permission every time an agent runs it.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

change="${1:-manual}"
[ -n "$(locked_files)" ] || die "nothing to lock: no files under tests/*.AcceptanceTests or src/**/Features/**/*.Contracts.cs"

current="$(mktemp)"
trap 'rm -f "$current"' EXIT
manifest > "$current"

if [ -f "$LOCK_FILE" ]; then
  changes="$(report_diff "$LOCK_FILE" "$current")"
  if [ -n "$changes" ]; then
    echo "Changes since the previous lock:"
    printf '%s\n' "$changes" | sed 's/^/  /'
  else
    echo "No changes since the previous lock."
  fi
fi

mkdir -p "$(dirname "$LOCK_FILE")"
{
  echo "# Acceptance test lock - approved by a human. Do not edit; regenerate with scripts/lock-tests.sh."
  echo "# change: $change"
  echo "# locked-at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat "$current"
} > "$LOCK_FILE"

echo "Locked $(wc -l < "$current" | tr -d ' ') files for '$change' in $LOCK_FILE."
