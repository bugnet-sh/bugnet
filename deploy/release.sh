#!/usr/bin/env bash
# Builds the gateway release tree that /opt/bugnet/gateway/<version> holds, and a tarball of it
#
#   deploy/release.sh [out-dir]    writes out-dir/gateway-<sha>/ and out-dir/gateway-<sha>.tgz
#
# The tree is self-contained, since dist/main.js and dist/x402-crawl.js bundle every dependency
# and the server needs only Node. It also carries the reviewed x402 index, which each deploy
# copies to Payments and the router, and the systemd units. It builds from a clean checkout only,
# so the version name is the commit it was built from.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
out_base=$(mkdir -p "${1:-$repo/release}" && cd "${1:-$repo/release}" && pwd)
cd "$repo"

if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
	echo "release.sh: the checkout has uncommitted changes, commit them first" >&2
	exit 1
fi
version=$(git rev-parse --short=7 HEAD)
out=$out_base/gateway-$version
rm -rf "$out" "$out.tgz"

pnpm install --frozen-lockfile
cd packages/gateway
# The router client comes from the bugnet-proto checkout beside this repository
pnpm proto
pnpm exec tsc --noEmit -p .

# Bundled CommonJS dependencies call require, which an ES module lacks without this banner
banner='import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);'
for entry in src/main.ts:main.js scripts/x402-crawl.ts:x402-crawl.js; do
	pnpm exec esbuild "${entry%%:*}" --bundle --platform=node --format=esm \
		--target=node26 --banner:js="$banner" --log-level=warning \
		--outfile="$out/packages/gateway/dist/${entry##*:}"
done
cd "$repo"

mkdir -p "$out/packages/gateway/src/x402" "$out/deploy"
cp packages/gateway/src/x402/index.json "$out/packages/gateway/src/x402/"
printf '{\n    "name": "@bugnet/gateway",\n    "private": true,\n    "type": "module"\n}\n' \
	>"$out/packages/gateway/package.json"
cp deploy/bugnet-gateway@.service deploy/bugnet-x402-crawl@.service \
	deploy/bugnet-x402-crawl@.timer "$out/deploy/"
node --check "$out/packages/gateway/dist/main.js"

# macOS tar adds extended attributes that GNU tar on the server warns about
flags=()
if tar --no-xattrs -cf /dev/null -T /dev/null 2>/dev/null; then flags=(--no-xattrs); fi
COPYFILE_DISABLE=1 tar ${flags[@]+"${flags[@]}"} -czf "$out.tgz" -C "$out" .

echo "release.sh: built $out"
echo "release.sh: tarball $out.tgz"
