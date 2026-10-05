#!/usr/bin/env bash
# Usage: scripts/verify.sh <change-name>
#
# The phase 4 gate: build, run every test (acceptance, unit, architecture), check
# that the locked acceptance tests and contracts are untouched, and check that every
# scenario of the change has exactly one acceptance test.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

change="${1:-}"
if [ -z "$change" ]; then
  echo "usage: scripts/verify.sh <change-name>" >&2
  exit 2
fi

failures=""
step() {
  local name="$1"
  shift
  echo
  echo "==> $name"
  if "$@"; then
    echo "    ok"
  else
    failures="$failures
  - $name"
  fi
}

step "build" dotnet build --nologo
step "tests (acceptance, unit, architecture)" dotnet test --nologo --no-build
step "acceptance test lock" scripts/check-test-lock.sh
step "scenario coverage" scripts/check-scenarios.sh "$change" --tests

echo
if [ -z "$failures" ]; then
  echo "VERIFY PASSED"
else
  echo "VERIFY FAILED:$failures"
  exit 1
fi
