#!/bin/bash
# Builds a universal (Apple silicon + Intel) hub binary for macOS 12+ into dist/mandarin-hub.
set -euo pipefail
cd "$(dirname "$0")/../hub"
VERSION="${VERSION:-$(git describe --tags --always --dirty)}"
mkdir -p ../dist
export CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=12.0
for arch in arm64 amd64; do
  carch=$arch; [ $arch = amd64 ] && carch=x86_64
  GOARCH=$arch CGO_CFLAGS="-arch $carch -mmacosx-version-min=12.0" CGO_LDFLAGS="-arch $carch -mmacosx-version-min=12.0" \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "../dist/mandarin-hub-$arch" .
done
lipo -create -output ../dist/mandarin-hub ../dist/mandarin-hub-arm64 ../dist/mandarin-hub-amd64
rm ../dist/mandarin-hub-arm64 ../dist/mandarin-hub-amd64
codesign --force --sign - ../dist/mandarin-hub
lipo -info ../dist/mandarin-hub
