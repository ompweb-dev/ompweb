#!/bin/sh
# The five binaries every release and prerelease ships (after `npm run build`), into release/:
# release/ompweb-<os>-<arch>.tar.gz, .zip for Windows. A prerelease archive holds its runner as ompweb-omp beside ompweb,
# downloaded from the fork release omp-runner.json pins (scripts/fetch-runner.ts); with --no-runner (releases) it does
# not, and ompweb fetches it from that release instead (lib/omp/runner-fetch.ts). Bun cross-compiles all of them from
# one machine.
# The x64 targets name -baseline (no AVX2 needed): in Bun 1.4.4 that is the default x64 runtime too (the
# same bytes), and naming it keeps a later Bun from shipping a -modern one. They keep the plain
# ompweb-<os>-x64 names.
set -eu
for target in bun-linux-x64-baseline bun-linux-arm64 bun-darwin-x64-baseline bun-darwin-arm64 bun-windows-x64-baseline; do
	npx bun scripts/build-binary.ts --target "$target" "$@"
done
# Every archive must pass the host updater's size limits and checks (lib/hosts/update-worker.ts).
for archive in release/ompweb-*.tar.gz release/ompweb-*.zip; do
	npx bun scripts/check-host-release-archive.ts "$archive"
done
