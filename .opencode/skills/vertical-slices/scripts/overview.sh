#!/usr/bin/env bash
# Usage: .opencode/skills/vertical-slices/scripts/overview.sh [slices|shared|platform|all] [filter]
#
# Prints an overview computed from the repository every time it runs - nothing to maintain:
#   slices    every slice under src/*/Features/<Area>/<Slice>: HTTP method and route
#   shared    every decision in openspec/decisions/shared-knowledge.md (superseded ones marked),
#             then every public type in src/*/Shared/Domain with its summary and the slices using it
#   platform  every decision in openspec/decisions/platform.md and whether it is in place
#   filter  keep only lines containing this text (case-insensitive)
set -euo pipefail
cd "$(dirname "$0")/../../../.."

what="${1:-all}"
filter="${2:-}"
case "$what" in
  slices | shared | platform | all) ;;
  *)
    echo "usage: overview.sh [slices|shared|platform|all] [filter]" >&2
    exit 2
    ;;
esac

# Prints its input lines that match the filter, or "- none" when nothing is left.
emit() {
  local out
  if [ -n "$filter" ]; then
    out="$(grep -iF -- "$filter" || true)"
  else
    out="$(cat)"
  fi
  if [ -n "$out" ]; then printf '%s\n' "$out"; else echo "- none"; fi
}

# src/<App>/Features/<Area>/<Slice>/... -> Area/Slice
slice_of() { sed -n 's#^src/[^/]*/Features/\([^/]*\)/\([^/]*\)/.*#\1/\2#p'; }

list_slices() {
  echo "## Slices"
  { find src -mindepth 4 -maxdepth 4 -type d -path 'src/*/Features/*/*' 2> /dev/null || true; } | LC_ALL=C sort |
    while IFS= read -r dir; do
      route="$({ grep -rhoE --include='*.Contracts.cs' 'const string Route = "[^"]*"' "$dir" || true; } |
        head -n 1 | sed -E 's/.*"([^"]*)"/\1/')"
      method="$({ grep -rhoE --include='*.cs' --exclude='*.Contracts.cs' 'Map(Get|Post|Put|Patch|Delete)\(' "$dir" || true; } |
        head -n 1 | sed -E 's/Map([A-Za-z]+)\(/\1/' | tr '[:lower:]' '[:upper:]')"
      echo "- ${dir#src/*/Features/}  ${method:-?} ${route:-(no Route constant)}"
    done | emit
}

# Prints one line per decision in a decision log (shared-knowledge.md or platform.md).
list_decisions() {
  local file="$1" prefix="$2"
  echo "### Decisions ($file)"
  if [ ! -f "$file" ]; then
    echo "- none"
    return
  fi
  awk -v prefix="$prefix" '
    function value(s) { sub(/^- \*\*[^*]+\*\*:[ \t]*/, "", s); sub(/[ \t\r]+$/, "", s); return s }
    /<!--/ { comment = 1 }
    comment { if (/-->/) comment = 0; next }
    $0 ~ "^## " prefix "-[0-9]+" {
      n++; id[n] = $2; sub(/:$/, "", id[n])
      rule[n] = $0; sub("^## " prefix "-[0-9]+:?[ \t]*", "", rule[n]); sub(/[ \t\r]+$/, "", rule[n])
      next
    }
    n && /^- \*\*Decision\*\*:/   { decision[n] = value($0) }
    n && /^- \*\*Applies to\*\*:/ { applies[n] = value($0) }
    n && /^- \*\*In place\*\*:/   { inplace[n] = value($0) }
    n && /^- \*\*Supersedes\*\*:/ {
      s = value($0)
      pattern = prefix "-[0-9]+"
      while (match(s, pattern)) { superseded[substr(s, RSTART, RLENGTH)] = id[n]; s = substr(s, RSTART + RLENGTH) }
    }
    END {
      for (i = 1; i <= n; i++) {
        line = "- " id[i] " " rule[i] " -> " (decision[i] == "" ? "?" : decision[i])
        if (applies[i] != "") line = line " (applies to: " applies[i] ")"
        if (inplace[i] != "") line = line " [in place: " inplace[i] "]"
        if (id[i] in superseded) line = line " [superseded by " superseded[id[i]] "]"
        print line
      }
    }
  ' "$file" | emit
}

list_shared_domain() {
  echo "### Code in Shared/Domain"
  { find src -type f -path 'src/*/Shared/Domain/*' -name '*.cs' -not -path '*/bin/*' -not -path '*/obj/*' 2> /dev/null || true; } |
    LC_ALL=C sort | while IFS= read -r file; do
      awk '
        /^[ \t]*\/\/\// {
          text = $0; sub(/^[ \t]*\/\/\/[ \t]?/, "", text); gsub(/<[^>]*>/, "", text); sub(/[ \t\r]+$/, "", text)
          if (text != "") doc = doc (doc == "" ? "" : " ") text
          next
        }
        /^[ \t]*\[/ { next }
        match($0, /public[ \t]+([a-z]+[ \t]+)*(class|record|struct|interface|enum)[ \t]+[A-Za-z_][A-Za-z0-9_]*/) {
          n = split(substr($0, RSTART, RLENGTH), words, /[ \t]+/)
          print words[n] "\t" doc
        }
        { doc = "" }
      ' "$file" | while IFS="$(printf '\t')" read -r type doc; do
        users="$({ grep -rlw --include='*.cs' -- "$type" src/*/Features 2> /dev/null || true; } |
          slice_of | LC_ALL=C sort -u | paste -sd ',' - | sed 's/,/, /g')"
        line="- $type ($file)"
        [ -n "$doc" ] && line="$line - $doc"
        echo "$line - used by: ${users:-no slice}"
      done
    done | emit
}

if [ "$what" = "slices" ] || [ "$what" = "all" ]; then
  list_slices
fi
if [ "$what" = "shared" ] || [ "$what" = "all" ]; then
  [ "$what" = "all" ] && echo
  echo "## Shared business rules"
  list_decisions openspec/decisions/shared-knowledge.md D
  list_shared_domain
fi
if [ "$what" = "platform" ] || [ "$what" = "all" ]; then
  [ "$what" = "all" ] && echo
  echo "## Platform"
  list_decisions openspec/decisions/platform.md P
fi
