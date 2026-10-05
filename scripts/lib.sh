# shellcheck shell=bash
# Shared helpers for the workflow scripts. Sourced, not executed.
# Paths are relative to the repository root; every script cd's there first.

# shellcheck disable=SC2034 # used by the scripts that source this file
LOCK_FILE=".workflow/acceptance.lock"

die() {
  echo "error: $*" >&2
  exit 2
}

# Acceptance test project folders: tests/<App>.AcceptanceTests
acceptance_dirs() {
  find tests -mindepth 1 -maxdepth 1 -type d -name '*.AcceptanceTests' 2>/dev/null | LC_ALL=C sort
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

# Every file the human approves at checkpoint 2: all acceptance test files (except
# build and test-run output, hidden and IDE files) and every slice contract.
locked_files() {
  {
    acceptance_dirs | while IFS= read -r dir; do
      find "$dir" -type f -not -path '*/bin/*' -not -path '*/obj/*' \
        -not -path '*/TestResults/*' -not -path '*/.*' -not -name '*.user'
    done
    if [ -d src ]; then
      find src -type f -path '*/Features/*' -name '*.Contracts.cs' \
        -not -path '*/bin/*' -not -path '*/obj/*'
    fi
  } | LC_ALL=C sort
}

# "<sha256>  <path>" per locked file.
manifest() {
  locked_files | while IFS= read -r f; do
    sha256_of "$f"
  done
}

# Compares two manifests. Prints "added|changed|removed: <path>" lines, sorted.
report_diff() {
  awk '
    /^#/ || length($0) < 67 { next }
    { hash = substr($0, 1, 64); path = substr($0, 67) }
    FILENAME == ARGV[1] { old[path] = hash; next }
    { new[path] = hash }
    END {
      for (p in new) {
        if (!(p in old)) print "added:   " p
        else if (old[p] != new[p]) print "changed: " p
      }
      for (p in old) if (!(p in new)) print "removed: " p
    }
  ' "$1" "$2" | LC_ALL=C sort
}
