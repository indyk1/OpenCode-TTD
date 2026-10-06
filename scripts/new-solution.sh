#!/usr/bin/env bash
# Usage: scripts/new-solution.sh <RootNamespace> "<Title> - <description>"
#        e.g. scripts/new-solution.sh AcmeOrders "Acme Orders - lets small shops take orders online"
#
# Creates the projects for a new vertical-slice solution. Run by the platform agent (/setup),
# which then writes the slice infrastructure from the vertical-slices skill:
#   <RootNamespace>.slnx (.sln on older SDKs)
#   src/<App>                        ASP.NET Core minimal API
#   tests/<App>.AcceptanceTests      NUnit + Microsoft.AspNetCore.Mvc.Testing + NSubstitute
#   tests/<App>.UnitTests            NUnit + NSubstitute
#   tests/<App>.ArchitectureTests    NUnit + ArchUnitNET
#   src/<App>.AppHost                .NET Aspire AppHost (runs the app and its resources)
#   src/<App>.ServiceDefaults        .NET Aspire service defaults (health, telemetry, resilience)
# Every package added is free and OSI-licensed (MIT, BSD-3-Clause or Apache-2.0).
# It also records the description as the first line of the context block in
# openspec/config.yaml, so every planning artifact knows what the application is for.
# First it makes the folder a git repository if it is not in one yet - without committing:
# the human makes the first commit, and scripts/finish-change.sh saves each change after
# that - and makes sure .gitignore keeps local settings files out of git (local development
# secrets belong in user secrets).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

app="${1:-}"
about="${2:-}"
usage="usage: scripts/new-solution.sh <RootNamespace> \"<Title> - <description>\""
[[ "$app" =~ ^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$ ]] ||
  die "$usage   (namespace: letters, digits, underscores and dots, e.g. AcmeOrders)"
[ -n "$about" ] || die "$usage"
grep -q "^context: |" openspec/config.yaml 2> /dev/null ||
  die "openspec/config.yaml has no 'context: |' block to record the description in"
command -v dotnet > /dev/null 2>&1 || die "the .NET SDK is not installed (https://dot.net)"
command -v git > /dev/null 2>&1 || die "git is not installed (https://git-scm.com)"
if compgen -G "*.sln" > /dev/null || compgen -G "*.slnx" > /dev/null || compgen -G "src/*/*.csproj" > /dev/null; then
  die "a solution already exists here - this script is only for new solutions"
fi

sdk_major="$(dotnet --version | cut -d. -f1)"
[ "$sdk_major" -ge 10 ] || die ".NET SDK 10 or later is required for Aspire (found $(dotnet --version))"

quiet() { "$@" > /dev/null; }

echo "==> Setting up git"
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  # The human's own default branch name, otherwise main. Passing it also keeps newer git quiet.
  git -c init.defaultBranch="$(git config --get init.defaultBranch || echo main)" init -q
fi
[ -f .gitignore ] || quiet dotnet new gitignore
# Local settings files never go into git, even in a repository that came with its own .gitignore.
# A line may end in a carriage return: dotnet writes the file with CRLF line endings on Windows.
missing=()
for entry in local.settings.json .env; do
  grep -qxF -e "$entry" -e "$entry"$'\r' .gitignore || missing+=("$entry")
done
if [ "${#missing[@]}" -gt 0 ]; then
  {
    echo
    echo "# Local settings - never commit them. Local development secrets go in user secrets (dotnet user-secrets)."
    printf '%s\n' "${missing[@]}"
  } >> .gitignore
fi

echo "==> Creating the solution and projects for $app (.NET SDK $(dotnet --version))"
quiet dotnet new sln -n "$app"
quiet dotnet new web -n "$app" -o "src/$app"
projects=("src/$app/$app.csproj")
for kind in AcceptanceTests UnitTests ArchitectureTests; do
  quiet dotnet new nunit -n "$app.$kind" -o "tests/$app.$kind"
  rm -f "tests/$app.$kind/UnitTest1.cs"
  quiet dotnet add "tests/$app.$kind/$app.$kind.csproj" reference "src/$app/$app.csproj"
  projects+=("tests/$app.$kind/$app.$kind.csproj")
done
echo "==> Adding Aspire (AppHost + ServiceDefaults)"
quiet dotnet new install Aspire.ProjectTemplates
quiet dotnet new aspire-servicedefaults -n "$app.ServiceDefaults" -o "src/$app.ServiceDefaults"
quiet dotnet new aspire-apphost -n "$app.AppHost" -o "src/$app.AppHost"
quiet dotnet add "src/$app/$app.csproj" reference "src/$app.ServiceDefaults/$app.ServiceDefaults.csproj"
quiet dotnet add "src/$app.AppHost/$app.AppHost.csproj" reference "src/$app/$app.csproj"
projects+=("src/$app.AppHost/$app.AppHost.csproj" "src/$app.ServiceDefaults/$app.ServiceDefaults.csproj")

quiet dotnet sln add "${projects[@]}"

echo "==> Adding packages"
add_package() { quiet dotnet add "tests/$app.$1/$app.$1.csproj" package "${@:2}"; }
add_package AcceptanceTests Microsoft.AspNetCore.Mvc.Testing --version "$sdk_major.*" # MIT
add_package AcceptanceTests NSubstitute                                                # BSD-3-Clause
add_package AcceptanceTests NSubstitute.Analyzers.CSharp                               # MIT
add_package UnitTests NSubstitute
add_package UnitTests NSubstitute.Analyzers.CSharp
add_package ArchitectureTests TngTech.ArchUnitNET                                      # Apache-2.0

echo "==> Recording the description in openspec/config.yaml"
# Written by the script rather than by hand: a malformed config.yaml makes OpenSpec
# silently ignore it. ENVIRON avoids awk escape processing of the description.
ABOUT="$(printf '%s' "$about" | tr '\r\n\t' '   ')" awk '
  /^context: \|/ && !done { print; print "  Application: " ENVIRON["ABOUT"]; done = 1; replacing = 1; next }
  replacing && /^  Application: / { next }
  { replacing = 0; print }
' openspec/config.yaml > openspec/config.yaml.tmp
mv openspec/config.yaml.tmp openspec/config.yaml

echo "==> Created"
for project in "${projects[@]}"; do
  echo "  $project"
done
echo "Next: write the slice and AppHost infrastructure from the vertical-slices skill, then dotnet build and dotnet test."
