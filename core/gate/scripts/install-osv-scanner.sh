#!/usr/bin/env bash
# Downloads the OSV-Scanner release pinned in tools.json for this platform,
# checks its sha256, and prints the binary's path.
#   install-osv-scanner.sh <directory>
set -euo pipefail

dest=${1:?usage: install-osv-scanner.sh <directory>}
tools="$(cd "$(dirname "$0")/.." && pwd)/tools.json"
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) platform=linux_amd64 ;;
  Darwin/arm64) platform=darwin_arm64 ;;
  *) echo "no pinned osv-scanner for $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac
version=$(node -p "require('$tools')['osv-scanner'].version")
sha256=$(node -p "require('$tools')['osv-scanner'].sha256['$platform'] ?? ''")
[ -n "$sha256" ] || { echo "tools.json has no osv-scanner sha256 for $platform" >&2; exit 1; }

mkdir -p "$dest"
binary="$dest/osv-scanner"
# A download name of its own: commands sharing a state dir may install at the same time, and the rename is atomic.
download=$(mktemp "$binary.download.XXXXXX")
trap 'rm -f "$download"' EXIT
curl -fsSL --retry 3 -o "$download" \
  "https://github.com/google/osv-scanner/releases/download/v$version/osv-scanner_$platform"
actual=$( (command -v sha256sum >/dev/null && sha256sum "$download" || shasum -a 256 "$download") | cut -d' ' -f1)
if [ "$actual" != "$sha256" ]; then
  echo "osv-scanner $version ($platform) has sha256 $actual, expected $sha256" >&2
  exit 1
fi
chmod +x "$download"
mv -f "$download" "$binary"
echo "$binary"
