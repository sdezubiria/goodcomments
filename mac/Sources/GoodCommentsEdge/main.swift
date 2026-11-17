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
let peek: CGFloat = 10               // a kept-open panel that's minimized leaves this much showing

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

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var panel: EdgePanel!
    var web: WKWebView!
    var statusItem: NSStatusItem!
    var pinItem: NSMenuItem!
    var shown = false
    var pinned = UserDefaults.standard.bool(forKey: "pinned")
    var edgeSince: Date?
    var awaySince: Date?
    var hotKey: EventHotKeyRef?
    var editing = false             // the drawing editor is open: the panel is a big window in the middle
    var picking = false             // a file picker is open: stay put
    var holdUntil = Date.distantPast // stay open a little after picking files or taking a screenshot
    var resizeHandle: ResizeHandle!

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
            guard let self, !self.pinned, !self.editing, !self.picking, Date() >= self.holdUntil,
                  !self.panel.frame.contains(NSEvent.mouseLocation) else { return }
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
        // the page's Keep open / Minimize buttons talk to us through window.webkit.messageHandlers.gc
        config.userContentController.add(self, name: "gc")
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
        resizeHandle = handle
    }

    func screenUnderPointer() -> NSScreen {
        let p = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(p, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
    }

    func shownFrame(_ s: NSScreen) -> NSRect {
        let v = s.visibleFrame
        return NSRect(x: v.maxX - panelWidth - margin, y: v.minY + margin, width: panelWidth, height: v.height - margin * 2)
    }

    func hiddenFrame(_ s: NSScreen) -> NSRect {
        pinned
            ? shownFrame(s).offsetBy(dx: panelWidth + margin - peek, dy: 0)   // tucked away, a sliver stays
            : shownFrame(s).offsetBy(dx: panelWidth + margin + 30, dy: 0)
    }

    func show(focus: Bool = false) {
        if editing { panel.makeKey(); return }
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
        if editing { return }
        panelWidth = min(max(width, minWidth), maxWidth)
        let s = panel.screen ?? screenUnderPointer()
        panel.setFrame(shownFrame(s), display: true)
    }

    func hide() {
        guard shown, !editing else { return }
        shown = false
        let s = panel.screen ?? screenUnderPointer()
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.24
            ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().setFrame(hiddenFrame(s), display: true)
        }, completionHandler: { [weak self] in
            guard let self, !self.shown, !self.pinned else { return }
            self.panel.orderOut(nil)
        })
    }

    @objc func toggle() {
        if shown && panel.isKeyWindow { hide() } else { show(focus: true) }
    }

    // Pointer watcher: polling the location needs no Accessibility permission.
    func tick() {
        if editing { return }
        if shown && (picking || Date() < holdUntil) { awaySince = nil; return }
        let p = NSEvent.mouseLocation
        if !shown {
            let s = screenUnderPointer()
            let onPeek = pinned && panel.isVisible && panel.frame.contains(p)
            let atEdge = onPeek || (p.x >= s.frame.maxX - 2 && p.y < s.visibleFrame.maxY && p.y > s.frame.minY + 40)
            if atEdge {
                // also while dragging: drag a screenshot or file to the edge and the column opens to take it
                let dwell = NSEvent.pressedMouseButtons == 0 ? edgeDwell : 0.35
                if edgeSince == nil { edgeSince = Date() }
                if Date().timeIntervalSince(edgeSince!) >= dwell { edgeSince = nil; show() }
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
        statusItem.button?.image = Self.monkeyTemplate()
        let menu = NSMenu()
        let showItem = NSMenuItem(title: "Show comments", action: #selector(toggle), keyEquivalent: "c")
        showItem.keyEquivalentModifierMask = [.control, .option]
        menu.addItem(showItem)
        menu.addItem(NSMenuItem(title: "Minimize", action: #selector(minimize), keyEquivalent: ""))
        let shotItem = NSMenuItem(title: "Take a screenshot…", action: #selector(captureFromMenu), keyEquivalent: "s")
        shotItem.keyEquivalentModifierMask = [.control, .option]
        menu.addItem(shotItem)
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
        if pinned { show() } else if !shown { panel.orderOut(nil) }   // unpinned while tucked away: hide fully
        pushState()
    }

    /// Minimize: slide away even when kept open (a sliver stays at the edge; hover or ⌃⌥C brings it back).
    @objc func minimize() {
        edgeSince = nil
        hide()
    }

    /// Tell the page whether the panel is kept open, so its button shows the right state.
    func pushState() {
        web.evaluateJavaScript("window.gcPanel && gcPanel({ pinned: \(pinned) })")
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "togglePin": togglePin()
        case "minimize": minimize()
        case "capture": capture(target: (body["target"] as? String) ?? "composer")
        case "editorOpen": enterEditor()
        case "editorClose": exitEditor()
        default: break
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { pushState() }

    @objc func openBrowser() { NSWorkspace.shared.open(URL(string: base)!) }
    @objc func reload() {
        ensureServer { [weak self] ok in
            if ok { self?.web.load(URLRequest(url: URL(string: "\(base)/?embed=1")!)) }
        }
    }

    // MARK: global hotkey ⌃⌥C (Carbon hotkeys need no permissions)

    var shotKey: EventHotKeyRef?

    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var hk = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            DispatchQueue.main.async {
                if hk.id == 2 { delegate.capture(target: "composer") } else { delegate.toggle() }
            }
            return noErr
        }, 1, &spec, nil, nil)
        let sig = OSType(0x4743_4D54) // "GCMT"
        RegisterEventHotKey(UInt32(kVK_ANSI_C), UInt32(controlKey | optionKey), EventHotKeyID(signature: sig, id: 1), GetApplicationEventTarget(), 0, &hotKey)
        RegisterEventHotKey(UInt32(kVK_ANSI_S), UInt32(controlKey | optionKey), EventHotKeyID(signature: sig, id: 2), GetApplicationEventTarget(), 0, &shotKey)
    }

    // MARK: drawing editor

    /// The column is too narrow to draw in: grow into a big window in the middle of the screen.
    func enterEditor() {
        guard !editing else { return }
        editing = true
        resizeHandle.isHidden = true
        let s = panel.screen ?? screenUnderPointer()
        let v = s.visibleFrame
        let w = min(v.width * 0.84, 1500)
        let h = min(v.height * 0.88, 1050)
        let target = NSRect(x: v.midX - w / 2, y: v.midY - h / 2, width: w, height: h)
        if !shown {
            panel.setFrame(hiddenFrame(s), display: false)
            panel.orderFrontRegardless()
            shown = true
        }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.32
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1.0)
            panel.animator().setFrame(target, display: true)
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKey()
    }

    /// Back to the column at the edge.
    func exitEditor() {
        guard editing else { return }
        editing = false
        resizeHandle.isHidden = false
        let s = panel.screen ?? screenUnderPointer()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.3
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0.8, 0.3, 1.0)
            panel.animator().setFrame(shownFrame(s), display: true)
        }
        awaySince = nil
    }

    // MARK: screenshots

    /// Hide the panel, let the user pick an area (or press Space for a window), then open it in the page's
    /// drawing editor. target: "composer" (new comment) or "ask" (the open fix / reopen box).
    @objc func captureFromMenu() { capture(target: "composer") }

    func capture(target: String) {
        panel.orderOut(nil)
        shown = false
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("goodcomments-\(UUID().uuidString).png")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-i", "-x", url.path]       // interactive area/window, no sound
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.holdUntil = Date().addingTimeInterval(4)
                self.show(focus: true)
                let safeTarget = target == "ask" ? "ask" : "composer"
                if let data = try? Data(contentsOf: url), !data.isEmpty {
                    try? FileManager.default.removeItem(at: url)
                    let b64 = data.base64EncodedString()
                    self.web.evaluateJavaScript("window.gcScreenshot && gcScreenshot('data:image/png;base64,\(b64)', '\(safeTarget)')")
                } else {
                    self.web.evaluateJavaScript("window.gcScreenshot && gcScreenshot(null, '\(safeTarget)')")
                }
            }
        }
        do { try p.run() } catch { show() }
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

    /// The logo's monkey, hanging from its stick, drawn as a menu bar template (adapts to light/dark).
    static func monkeyTemplate() -> NSImage {
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
            NSColor.black.setFill()
            NSColor.black.setStroke()
            NSBezierPath(roundedRect: NSRect(x: 1.5, y: 2, width: 15, height: 2.2), xRadius: 1.1, yRadius: 1.1).fill()  // stick
            for (from, to) in [(NSPoint(x: 6.6, y: 11), NSPoint(x: 5.2, y: 3.4)), (NSPoint(x: 11.4, y: 11), NSPoint(x: 12.8, y: 3.4))] {
                let arm = NSBezierPath(); arm.lineWidth = 1.9; arm.lineCapStyle = .round
                arm.move(to: from); arm.line(to: to); arm.stroke()
            }
            NSBezierPath(ovalIn: NSRect(x: 2.6, y: 9.1, width: 3.6, height: 3.6)).fill()     // ears
            NSBezierPath(ovalIn: NSRect(x: 11.8, y: 9.1, width: 3.6, height: 3.6)).fill()
            NSBezierPath(ovalIn: NSRect(x: 4.6, y: 7.6, width: 8.8, height: 8.8)).fill()     // head
            NSGraphicsContext.current?.compositingOperation = .destinationOut               // eyes and smile cut out
            NSBezierPath(ovalIn: NSRect(x: 6.7, y: 10.4, width: 1.6, height: 1.6)).fill()
            NSBezierPath(ovalIn: NSRect(x: 9.7, y: 10.4, width: 1.6, height: 1.6)).fill()
            let smile = NSBezierPath(); smile.lineWidth = 0.9; smile.lineCapStyle = .round
            smile.move(to: NSPoint(x: 7.3, y: 13.6)); smile.curve(to: NSPoint(x: 10.7, y: 13.6), controlPoint1: NSPoint(x: 8.3, y: 14.8), controlPoint2: NSPoint(x: 9.7, y: 14.8))
            smile.stroke()
            return true
        }
        img.isTemplate = true
        img.accessibilityDescription = "GoodComments"
        return img
    }

    static let offlineHTML = """
    <body style="font:13px system-ui;color:#555;padding:40px 28px;background:transparent">
    <b>GoodComments server isn't running.</b><br><br>Run <code>npm start</code> in the GoodComments folder, then choose Reload from the menu bar icon.</body>
    """

    // MARK: web view

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // a file dropped outside a drop zone would replace the column with the file: never
        if action.request.url?.isFileURL == true { return decisionHandler(.cancel) }
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

    /// The paperclip buttons (<input type="file">) need a native file picker in a WKWebView.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let open = NSOpenPanel()
        open.allowsMultipleSelection = parameters.allowsMultipleSelection
        open.canChooseDirectories = false
        open.canChooseFiles = true
        open.message = "Attach screenshots or documents"
        open.prompt = "Attach"
        picking = true
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKey()
        open.begin { [weak self] response in
            completionHandler(response == .OK ? open.urls : nil)
            guard let self else { return }
            self.picking = false
            self.holdUntil = Date().addingTimeInterval(4)   // give you time to write the comment
            self.panel.makeKey()
        }
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
