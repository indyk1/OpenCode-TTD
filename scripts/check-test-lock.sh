#!/usr/bin/env bash
# Usage: scripts/check-test-lock.sh [--list]
#
# Compares the acceptance tests and slice contracts with the lock the human approved.
#   (no flag)  exit 0 when nothing changed, 1 when something changed, 2 when there is no lock yet.
#   --list     print what was added, changed or removed since the last lock (always exit 0).
#              Used at checkpoint 2 to show the human exactly which files to review.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

mode="${1:-}"
current="$(mktemp)"
trap 'rm -f "$current"' EXIT
manifest > "$current"

if [ ! -f "$LOCK_FILE" ]; then
  if [ "$mode" = "--list" ]; then
    echo "No lock yet - every acceptance test file and contract is new:"
    report_diff /dev/null "$current" | sed 's/^/  /'
    exit 0
  fi
  echo "LOCK MISSING: the acceptance tests have not been approved and locked yet (scripts/lock-tests.sh)." >&2
  exit 2
fi

changes="$(report_diff "$LOCK_FILE" "$current")"
locked_for="$(sed -n 's/^# change: //p' "$LOCK_FILE" | head -n 1)"

if [ "$mode" = "--list" ]; then
  if [ -n "$changes" ]; then
    echo "Changed since the last lock ('$locked_for'):"
    printf '%s\n' "$changes" | sed 's/^/  /'
  else
    echo "Nothing changed since the last lock ('$locked_for')."
  fi
  exit 0
fi

if [ -n "$changes" ]; then
  echo "LOCK BROKEN: locked acceptance tests or contracts differ from what the human approved ('$locked_for'):" >&2
  printf '%s\n' "$changes" | sed 's/^/  /' >&2
  exit 1
fi

echo "Lock OK: acceptance tests and contracts match the approved lock ('$locked_for')."
