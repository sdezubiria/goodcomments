#!/bin/sh
# Builds mac/build/GoodComments.app (menu bar app, no Dock icon).
set -e
cd "$(dirname "$0")"
APP=build/GoodComments.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
# plain swiftc: one file, no SwiftPM needed. Prefer Xcode's toolchain when present
# (some Command Line Tools installs ship broken Swift module maps).
[ -d /Applications/Xcode.app ] && export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcrun swiftc -O -swift-version 5 Sources/GoodCommentsEdge/main.swift -o "$APP/Contents/MacOS/GoodComments"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>GoodComments</string>
  <key>CFBundleIdentifier</key><string>local.goodcomments.edge</string>
  <key>CFBundleExecutable</key><string>GoodComments</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "Built $(pwd)/$APP"
