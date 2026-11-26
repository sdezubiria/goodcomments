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
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleLocalizations</key><array><string>en</string><string>es</string></array>
  <key>CFBundleIdentifier</key><string>BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>GoodComments</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSScreenCaptureUsageDescription</key><string>GoodComments takes screenshots you choose, so you can draw on them and attach them to comments.</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSMenuItem</key><dict><key>default</key><string>Send to GoodComments</string></dict>
      <key>NSMessage</key><string>sendToGoodComments</string>
      <key>NSPortName</key><string>GoodComments</string>
      <key>NSSendTypes</key><array><string>NSStringPboardType</string><string>public.utf8-plain-text</string></array>
      <key>NSRequiredContext</key><dict/>
    </dict>
  </array>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
# the Services menu item in Spanish on a Mac set to Spanish (the app's own menus follow the board's Language setting)
mkdir -p "$APP/Contents/Resources/es.lproj"
printf '"Send to GoodComments" = "Enviar a GoodComments";\n' > "$APP/Contents/Resources/es.lproj/ServicesMenu.strings"
# GOODCOMMENTS_BUNDLE_ID gives a test build its own identity (settings, notifications, Services) next to the real app
BUNDLE_ID="${GOODCOMMENTS_BUNDLE_ID:-local.goodcomments.edge}"
sed -i '' "s/BUNDLE_ID/$BUNDLE_ID/" "$APP/Contents/Info.plist"
# Sign with a real identity when there is one, so macOS keeps permissions (Screen Recording) across rebuilds:
# an ad-hoc signature changes on every build, and macOS then asks again and doesn't apply the old approval.
# GOODCOMMENTS_SIGN_IDENTITY picks one (a name or SHA-1; "-" forces ad-hoc). Otherwise every Apple Development
# certificate is tried in turn: a revoked one still shows as "valid" in the keychain, but macOS treats code
# signed with it as malware (launch fails with POSIX 163 and XProtect deletes the app), so it's skipped.
if [ -n "$GOODCOMMENTS_SIGN_IDENTITY" ]; then
  CANDIDATES="$GOODCOMMENTS_SIGN_IDENTITY"
else
  CANDIDATES="$(security find-identity -v -p codesigning 2>/dev/null | sed -nE 's/^ *[0-9]+\) ([0-9A-F]{40}) "Apple Development: .*/\1/p')"
fi
SIGNED=""
while IFS= read -r ID; do
  [ -z "$ID" ] && continue
  [ "$ID" = "-" ] && break
  codesign --force --sign "$ID" --identifier "$BUNDLE_ID" "$APP" >/dev/null 2>&1 || { echo "warning: couldn't sign with \"$ID\"" >&2; continue; }
  if spctl -a -vv -t exec "$APP" 2>&1 | grep -q REVOKED; then echo "note: skipping a revoked certificate ($ID)" >&2; continue; fi
  SIGNED="$ID"
  break
done <<EOF
$CANDIDATES
EOF
if [ -n "$SIGNED" ]; then
  echo "Signed with $(security find-identity -v -p codesigning 2>/dev/null | grep "$SIGNED" | sed -nE 's/.*"([^"]+)".*/\1/p' | head -1)"
else
  echo "warning: no usable signing certificate: using an ad-hoc signature, so macOS will ask for Screen Recording again after this build" >&2
  codesign --force --sign - "$APP" >/dev/null 2>&1 || true
fi
codesign --verify --strict "$APP" || { echo "error: $APP is not signed correctly" >&2; exit 1; }
echo "Built $(pwd)/$APP"
