// GoodComments edge panel: the comment column lives just past the right edge of
// the screen. Rest the pointer on the right edge (or press ⌃⌥C) and it slides in.
import AppKit
import Carbon.HIToolbox
import WebKit

let port = ProcessInfo.processInfo.environment["GOODCOMMENTS_PORT"] ?? "4477"
let base = "http://127.0.0.1:\(port)"
let minWidth: CGFloat = 340
let maxWidth: CGFloat = 900
var panelWidth: CGFloat = {
    let saved = CGFloat(UserDefaults.standard.double(forKey: "width"))
    return saved > 0 ? min(max(saved, minWidth), maxWidth) : 460
}()
let margin: CGFloat = 8
let edgeDwell: TimeInterval = 0.22   // how long the pointer rests on the edge before the line slides in
let leaveDelay: TimeInterval = 0.6   // how long the pointer is away before it slides out

final class EdgePanel: NSPanel {
    weak var web: WKWebView?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    // The panel doesn't activate the app, so the main menu may never see ⌘-keys:
    // send the standard edit actions to the focused element ourselves.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if mods == .command || mods == [.command, .shift], let key = event.charactersIgnoringModifiers?.lowercased() {
            // ⌘Z / ⌘⇧Z: the page undoes moves (approve, fix, reopen); text fields keep native undo.
            if key == "z", let web {
                let redo = mods.contains(.shift)
                web.evaluateJavaScript("window.gcUndo ? gcUndo(\(redo)) : 'native'") { result, _ in
                    if (result as? String) != "handled" {
                        NSApp.sendAction(redo ? Selector(("redo:")) : Selector(("undo:")), to: nil, from: self)
                    }
                }
                return true
            }
            let action: Selector? = switch (key, mods.contains(.shift)) {
            case ("v", false): #selector(NSText.paste(_:))
            case ("c", false): #selector(NSText.copy(_:))
            case ("x", false): #selector(NSText.cut(_:))
            case ("a", false): #selector(NSText.selectAll(_:))
            case ("z", false): Selector(("undo:"))
            case ("z", true): Selector(("redo:"))
            default: nil
            }
            if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        }
        return super.performKeyEquivalent(with: event)
    }

    // let the panel park itself off-screen
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

/// A thin strip on the panel's left edge: drag it to make the column wider or narrower.
final class ResizeHandle: NSView {
    var onResize: ((CGFloat) -> Void)?
    var onEnd: (() -> Void)?
    private var startX: CGFloat = 0
    private var startWidth: CGFloat = 0

    override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        startX = NSEvent.mouseLocation.x
        startWidth = window?.frame.width ?? panelWidth
    }
    override func mouseDragged(with event: NSEvent) {
        onResize?(startWidth + (startX - NSEvent.mouseLocation.x))
    }
    override func mouseUp(with event: NSEvent) { onEnd?() }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var panel: EdgePanel!
    var web: WKWebView!
    var statusItem: NSStatusItem!
    var pinItem: NSMenuItem!
    var shown = false
    var pinned = UserDefaults.standard.bool(forKey: "pinned")
    var edgeSince: Date?
    var awaySince: Date?
    var hotKey: EventHotKeyRef?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildEditMenu()
        buildPanel()
        buildMenu()
        registerHotKey()
        ensureServer { [weak self] ok in
            guard let self else { return }
            if ok { self.web.load(URLRequest(url: URL(string: "\(base)/?embed=1")!)) }
            else { self.web.loadHTMLString(Self.offlineHTML, baseURL: nil) }
        }
        Timer.scheduledTimer(withTimeInterval: 0.07, repeats: true) { [weak self] _ in self?.tick() }
        NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
            guard let self, !self.pinned, !self.panel.frame.contains(NSEvent.mouseLocation) else { return }
            self.hide()
        }
        if pinned { show() }
    }

    // MARK: panel

    func buildPanel() {
        panel = EdgePanel(contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: 600),
                          styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]

        let glass = NSVisualEffectView()
        glass.material = .popover
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.wantsLayer = true
        glass.layer?.cornerRadius = 18
        glass.layer?.masksToBounds = true
        glass.layer?.borderWidth = 0.5
        glass.layer?.borderColor = NSColor.white.withAlphaComponent(0.35).cgColor

        let config = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.underPageBackgroundColor = .clear
        web.navigationDelegate = self
        web.uiDelegate = self
        web.autoresizingMask = [.width, .height]
        panel.web = web

        glass.addSubview(web)
        panel.contentView = glass
        web.frame = glass.bounds

        let handle = ResizeHandle(frame: NSRect(x: 0, y: 0, width: 7, height: glass.bounds.height))
        handle.autoresizingMask = [.height, .maxXMargin]
        handle.onResize = { [weak self] w in self?.resize(to: w) }
        handle.onEnd = { UserDefaults.standard.set(Double(panelWidth), forKey: "width") }
        glass.addSubview(handle)
    }

    func screenUnderPointer() -> NSScreen {
        let p = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(p, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
    }

    func shownFrame(_ s: NSScreen) -> NSRect {
        let v = s.visibleFrame
        return NSRect(x: v.maxX - panelWidth - margin, y: v.minY + margin, width: panelWidth, height: v.height - margin * 2)
    }

    func hiddenFrame(_ s: NSScreen) -> NSRect { shownFrame(s).offsetBy(dx: panelWidth + margin + 30, dy: 0) }

    func show(focus: Bool = false) {
        let s = shown ? (panel.screen ?? screenUnderPointer()) : screenUnderPointer()
        if !shown {
            panel.setFrame(hiddenFrame(s), display: false)
            panel.orderFrontRegardless()
        }
        shown = true
        awaySince = nil
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.32
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.95, 0.25, 1.0)
            panel.animator().setFrame(shownFrame(s), display: true)
        }
        if focus {
            panel.makeKey()
            web.evaluateJavaScript("document.getElementById('c-body')?.focus()")
        }
    }

    func resize(to width: CGFloat) {
        panelWidth = min(max(width, minWidth), maxWidth)
        let s = panel.screen ?? screenUnderPointer()
        panel.setFrame(shownFrame(s), display: true)
    }

    func hide() {
        guard shown else { return }
        shown = false
        let s = panel.screen ?? screenUnderPointer()
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.24
            ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().setFrame(hiddenFrame(s), display: true)
        }, completionHandler: { [weak self] in
            guard let self, !self.shown else { return }
            self.panel.orderOut(nil)
        })
    }

    @objc func toggle() {
        if shown && panel.isKeyWindow { hide() } else { show(focus: true) }
    }

    // Pointer watcher: polling the location needs no Accessibility permission.
    func tick() {
        let p = NSEvent.mouseLocation
        if !shown {
            let s = screenUnderPointer()
            let atEdge = p.x >= s.frame.maxX - 2 && p.y < s.visibleFrame.maxY && p.y > s.frame.minY + 40
            if atEdge && NSEvent.pressedMouseButtons == 0 {
                if edgeSince == nil { edgeSince = Date() }
                if Date().timeIntervalSince(edgeSince!) >= edgeDwell { edgeSince = nil; show() }
            } else { edgeSince = nil }
            return
        }
        guard !pinned else { return }
        let near = panel.frame.insetBy(dx: -18, dy: -18).contains(p)
        if near || panel.isKeyWindow { awaySince = nil; return }
        if awaySince == nil { awaySince = Date() }
        if Date().timeIntervalSince(awaySince!) >= leaveDelay { hide() }
    }

    // MARK: Edit menu
    // Menu-bar-only apps have no main menu by default, and without one ⌘V, ⌘C,
    // ⌘X, ⌘A and ⌘Z never reach the web view. It stays invisible (no Dock icon).
    func buildEditMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = NSMenu()
        main.addItem(appItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
    }

    // MARK: menu bar

    func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "text.bubble", accessibilityDescription: "GoodComments")
        let menu = NSMenu()
        let showItem = NSMenuItem(title: "Show comments", action: #selector(toggle), keyEquivalent: "c")
        showItem.keyEquivalentModifierMask = [.control, .option]
        menu.addItem(showItem)
        pinItem = NSMenuItem(title: "Keep open", action: #selector(togglePin), keyEquivalent: "")
        pinItem.state = pinned ? .on : .off
        menu.addItem(pinItem)
        menu.addItem(NSMenuItem(title: "Open in browser", action: #selector(openBrowser), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Reload", action: #selector(reload), keyEquivalent: "r"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit GoodComments", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        for item in menu.items where item.action != #selector(NSApplication.terminate(_:)) { item.target = self }
        statusItem.menu = menu
    }

    @objc func togglePin() {
        pinned.toggle()
        UserDefaults.standard.set(pinned, forKey: "pinned")
        pinItem.state = pinned ? .on : .off
        if pinned { show() }
    }

    @objc func openBrowser() { NSWorkspace.shared.open(URL(string: base)!) }
    @objc func reload() {
        ensureServer { [weak self] ok in
            if ok { self?.web.load(URLRequest(url: URL(string: "\(base)/?embed=1")!)) }
        }
    }

    // MARK: global hotkey ⌃⌥C (Carbon hotkeys need no permissions)

    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { delegate.toggle() }
            return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x4743_4D54), id: 1) // "GCMT"
        RegisterEventHotKey(UInt32(kVK_ANSI_C), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &hotKey)
    }

    // MARK: local server

    func ping(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: "\(base)/api/health")!)
        req.timeoutInterval = 0.8
        URLSession.shared.dataTask(with: req) { _, res, _ in
            let ok = (res as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    /// Start `node server/index.js` from the GoodComments folder if it isn't running.
    func ensureServer(_ done: @escaping (Bool) -> Void) {
        ping { [weak self] ok in
            guard let self else { return }
            if ok { return done(true) }
            guard let root = Self.findRoot() else { return done(false) }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            p.arguments = ["-lc", "exec node --no-warnings \"\(root)/server/index.js\""]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
            self.waitForServer(tries: 40, done)
        }
    }

    func waitForServer(tries: Int, _ done: @escaping (Bool) -> Void) {
        ping { [weak self] ok in
            if ok || tries == 0 { return done(ok) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self?.waitForServer(tries: tries - 1, done) }
        }
    }

    static func findRoot() -> String? {
        if let env = ProcessInfo.processInfo.environment["GOODCOMMENTS_HOME"] { return env }
        if let saved = UserDefaults.standard.string(forKey: "root") { return saved }
        var url = Bundle.main.bundleURL
        for _ in 0..<6 {
            url.deleteLastPathComponent()
            if FileManager.default.fileExists(atPath: url.appendingPathComponent("server/index.js").path) {
                UserDefaults.standard.set(url.path, forKey: "root")
                return url.path
            }
        }
        return nil
    }

    static let offlineHTML = """
    <body style="font:13px system-ui;color:#555;padding:40px 28px;background:transparent">
    <b>GoodComments server isn't running.</b><br><br>Run <code>npm start</code> in the GoodComments folder, then choose Reload from the menu bar icon.</body>
    """

    // MARK: web view

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, action.navigationType == .linkActivated, !url.absoluteString.hasPrefix(base) {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }
}

let delegate = AppDelegate()
let app = NSApplication.shared
app.delegate = delegate
app.run()
