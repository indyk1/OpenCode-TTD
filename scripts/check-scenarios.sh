#!/usr/bin/env bash
# Usage: scripts/check-scenarios.sh <change-name> [--plan|--tests]
#
# Checks the 1:1 link between OpenSpec scenarios and tests. A scenario's ID is
# "<capability-path>: <scenario name>".
#
#   --plan   every ADDED/MODIFIED scenario of the change has exactly one
#            "### <ID>" entry in the change's test-plan.md, and no entry is unknown.
#   --tests  (default) every ADDED/MODIFIED scenario has exactly one acceptance test
#            tagged [Property("Scenario", "<ID>")], and scenarios of REMOVED
#            requirements have none. Tests whose ID matches no scenario are warnings.
#
# Exit codes: 0 consistent, 1 inconsistent, 2 usage error.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

change="${1:-}"
mode="${2:---tests}"
[ -n "$change" ] || die "usage: scripts/check-scenarios.sh <change-name> [--plan|--tests]"
case "$mode" in --plan | --tests) ;; *) die "unknown mode '$mode' (use --plan or --tests)" ;; esac
change_dir="openspec/changes/$change"
[ -d "$change_dir" ] || die "no active change at $change_dir"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Prints "E<TAB>id" for each scenario the change adds or modifies and "R<TAB>id" for
# each scenario it retires (scenarios of a REMOVED requirement, or any dropped from a
# MODIFIED one), using the main spec to know the current scenarios.
# shellcheck disable=SC2016
parse_delta='
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
function after_colon(s) { return trim(substr(s, index(s, ":") + 1)) }
BEGIN {
  while ((getline line < main) > 0) {
    if (line ~ /^## /) { req = ""; continue }
    if (line ~ /^### Requirement:/) { req = after_colon(line); continue }
    if (req != "" && line ~ /^#### Scenario:/) old[req] = old[req] "\n" after_colon(line)
  }
  close(main)
  req = ""
}
/^## / {
  sec = ""
  if ($0 ~ /^## ADDED Requirements/) sec = "ADDED"
  else if ($0 ~ /^## MODIFIED Requirements/) sec = "MODIFIED"
  else if ($0 ~ /^## REMOVED Requirements/) sec = "REMOVED"
  req = ""
  next
}
/^### Requirement:/ {
  req = after_colon($0)
  if (sec == "MODIFIED" || sec == "REMOVED") touched[req] = sec
  next
}
/^#### Scenario:/ {
  if (sec == "ADDED" || sec == "MODIFIED") {
    name = after_colon($0)
    print "E\t" cap ": " name
    if (sec == "MODIFIED") kept[req "\n" name] = 1
  }
}
END {
  for (r in touched) {
    n = split(old[r], names, "\n")
    for (i = 2; i <= n; i++)
      if (touched[r] == "REMOVED" || !((r "\n" names[i]) in kept)) print "R\t" cap ": " names[i]
  }
}'

# Prints the ID of every scenario in a main spec.
# shellcheck disable=SC2016
parse_main='
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
/^#### Scenario:/ { print cap ": " trim(substr($0, index($0, ":") + 1)) }'

: > "$work/delta"
if [ -d "$change_dir/specs" ]; then
  find "$change_dir/specs" -type f -name spec.md | LC_ALL=C sort | while IFS= read -r delta; do
    cap="${delta#"$change_dir/specs/"}"
    cap="${cap%/spec.md}"
    awk -v cap="$cap" -v main="openspec/specs/$cap/spec.md" "$parse_delta" "$delta"
  done > "$work/delta"
fi

{ grep '^E	' "$work/delta" || true; } | cut -f2- | LC_ALL=C sort > "$work/expected_all"
LC_ALL=C sort -u "$work/expected_all" > "$work/expected"
{ grep '^R	' "$work/delta" || true; } | cut -f2- | LC_ALL=C sort -u > "$work/retired"

if [ ! -s "$work/expected" ] && [ ! -s "$work/retired" ]; then
  echo "No scenarios added, modified or removed by '$change' - nothing to check."
  exit 0
fi

count_in() { grep -cxF -- "$1" "$2" || true; }

missing=0
duplicated=0
unknown=0
stale=0

if [ "$mode" = "--plan" ]; then
  plan="$change_dir/test-plan.md"
  [ -f "$plan" ] || { echo "MISSING: $plan does not exist"; exit 1; }
  sed -n 's/^### //p' "$plan" | sed 's/[[:space:]]*$//' | LC_ALL=C sort > "$work/found"
  echo "Test plan coverage for '$change':"
else
  : > "$work/found"
  while IFS= read -r dir; do
    grep -rhoE --include='*.cs' --exclude-dir=bin --exclude-dir=obj \
      'Property\("Scenario",[[:space:]]*"[^"]*"\)' "$dir" || true
  done < <(acceptance_dirs) |
    sed -E 's/^Property\("Scenario",[[:space:]]*"([^"]*)"\)$/\1/' | LC_ALL=C sort > "$work/found"
  echo "Acceptance test coverage for '$change':"
fi

while IFS= read -r id; do
  n="$(count_in "$id" "$work/found")"
  if [ "$n" -eq 0 ]; then
    echo "  MISSING     $id"
    missing=$((missing + 1))
  elif [ "$n" -gt 1 ]; then
    echo "  DUPLICATED  $id  ($n times)"
    duplicated=$((duplicated + 1))
  else
    echo "  ok          $id"
  fi
done < "$work/expected"

if [ "$mode" = "--plan" ]; then
  while IFS= read -r id; do
    if [ "$(count_in "$id" "$work/expected")" -eq 0 ]; then
      echo "  UNKNOWN     $id  (test-plan entry matches no ADDED/MODIFIED scenario - check the spelling)"
      unknown=$((unknown + 1))
    fi
  done < <(LC_ALL=C sort -u "$work/found")
else
  while IFS= read -r id; do
    if [ "$(count_in "$id" "$work/found")" -gt 0 ]; then
      echo "  STALE       $id  (scenario retired - delete its test)"
      stale=$((stale + 1))
    fi
  done < "$work/retired"

  # Warn about tests that match no scenario at all.
  : > "$work/known"
  while IFS= read -r spec; do
    cap="${spec#openspec/specs/}"
    cap="${cap%/spec.md}"
    awk -v cap="$cap" "$parse_main" "$spec"
  done < <(find openspec/specs -type f -name spec.md 2> /dev/null | LC_ALL=C sort) >> "$work/known"
  cat "$work/expected" >> "$work/known"
  while IFS= read -r id; do
    if [ "$(count_in "$id" "$work/known")" -eq 0 ] && [ "$(count_in "$id" "$work/retired")" -eq 0 ]; then
      echo "  warning     orphan test '$id' matches no scenario in openspec/specs or this change"
    fi
  done < <(LC_ALL=C sort -u "$work/found")
fi

if [ $((missing + duplicated + unknown + stale)) -eq 0 ]; then
  echo "Result: OK"
  exit 0
fi
echo "Result: FAILED ($missing missing, $duplicated duplicated, $unknown unknown, $stale stale)"
exit 1
