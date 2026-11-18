#!/bin/sh
# Builds bin/omp-web-tray.exe from native/tray at the checked-out commit and checks that the exe carries that commit,
# so a release never ships a tray older than its sources (#530). Runs on Linux too: tray.csproj sets
# EnableWindowsTargeting. publish.yml runs it before npm publish; verify-pr.yml runs it on every PR.
set -eu
sha=$(git rev-parse HEAD)
out=$(mktemp -d)
dotnet publish native/tray/tray.csproj -c Release -r win-x64 -p:SourceRevisionId="$sha" -o "$out"
grep -qa "+$sha" "$out/omp-web-tray.exe" || { echo "omp-web-tray.exe does not carry commit $sha" >&2; exit 1; }
cp "$out/omp-web-tray.exe" bin/omp-web-tray.exe
rm -rf "$out"
echo "bin/omp-web-tray.exe built from $sha"
