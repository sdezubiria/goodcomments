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
mkdir -p "$APP/Contents/Resources"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>GoodComments</string>
  <key>CFBundleIdentifier</key><string>local.goodcomments.edge</string>
  <key>CFBundleExecutable</key><string>GoodComments</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSScreenCaptureUsageDescription</key><string>GoodComments takes screenshots you choose, so you can draw on them and attach them to comments.</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
# Sign with a real identity when there is one (GOODCOMMENTS_SIGN_IDENTITY=- forces ad-hoc), so macOS keeps permissions (Screen Recording)
# across rebuilds; an ad-hoc signature changes on every build and makes macOS ask again.
IDENTITY="${GOODCOMMENTS_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -nE 's/.*"(Apple Development: [^"]+)".*/\1/p' | head -1)}"
if [ -n "$IDENTITY" ]; then
  codesign --force --sign "$IDENTITY" --identifier local.goodcomments.edge "$APP" >/dev/null 2>&1 \
    || { echo "warning: couldn't sign with \"$IDENTITY\"; using an ad-hoc signature" >&2; codesign --force --sign - "$APP" >/dev/null 2>&1 || true; }
else
  codesign --force --sign - "$APP" >/dev/null 2>&1 || true
fi
echo "Built $(pwd)/$APP"
