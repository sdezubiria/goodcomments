// GoodComments edge panel: the comment column lives just past the right edge of
// the screen. Rest the pointer on the right edge (or press ⌃⌥C) and it slides in.
import AppKit
import Carbon.HIToolbox
import UserNotifications
import WebKit

// MARK: language
// The board's Settings → Language (auto, en or es), passed on by the page and kept here, so the menus
// start in it next time too. "auto" follows the Mac's preferred languages.
func appLanguage() -> String {
    let pref = UserDefaults.standard.string(forKey: "language") ?? "auto"
    if pref == "en" || pref == "es" { return pref }
    let first = Locale.preferredLanguages.first { $0.hasPrefix("es") || $0.hasPrefix("en") } ?? "en"
    return first.hasPrefix("es") ? "es" : "en"
}

let spanish: [String: String] = [
    "Edit": "Edición", "Undo": "Deshacer", "Redo": "Rehacer", "Cut": "Cortar", "Copy": "Copiar", "Paste": "Pegar", "Select All": "Seleccionar todo",
    "Show comments": "Mostrar comentarios", "New comment…": "Nuevo comentario…", "Minimize": "Minimizar", "Take a screenshot…": "Tomar una captura…",
    "Keep open": "Mantener abierto", "Open in browser": "Abrir en el navegador", "Reload": "Volver a cargar",
    "Quit GoodComments": "Salir de GoodComments",
    "Choose": "Elegir", "Choose the project’s folder": "Elige la carpeta del proyecto",
    "Ready to check": "Listo para revisar", "Fixed by ": "Arreglado por ",
    "Attach screenshots or documents": "Adjuntar capturas o documentos", "Attach": "Adjuntar", "Cancel": "Cancelar", "OK": "OK",
]

/** The words in the app's language. */
func L(_ en: String) -> String { appLanguage() == "es" ? (spanish[en] ?? en) : en }

let port = ProcessInfo.processInfo.environment["GOODCOMMENTS_PORT"] ?? "4477"
/// The board this Mac shows: the server on this Mac.
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
let quickHeight: CGFloat = 150       // the ⌃⌥N window

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

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
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
    var backFromEditor = false      // just back at the edge from the editor or a screenshot: stay open until the pointer has been on the panel
    var picking = false             // a file picker is open: stay put
    var holdUntil = Date.distantPast // stay open a little after picking files or taking a screenshot
    var resizeHandle: ResizeHandle!
    var quick: EdgePanel!            // the ⌃⌥N quick-capture window
    var quickWeb: WKWebView!
    var quickLoaded = false
    var fixedSeen: [Int: String]?   // comment id → fixed_at, from the last poll (nil until the first one)
    var ownMoves: [Int: Date] = [:] // cards you moved in the panel: no notification for those

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildEditMenu()
        buildPanel()
        buildMenu()
        registerHotKey()
        buildQuick()
        NSApp.servicesProvider = self
        NSUpdateDynamicServices()
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in self?.pollToCheck() }
        loadBoard()
        Timer.scheduledTimer(withTimeInterval: 0.07, repeats: true) { [weak self] _ in self?.tick() }
        NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
            guard let self, !self.pinned, !self.editing, !self.picking, !self.backFromEditor, Date() >= self.holdUntil,
                  !self.panel.frame.contains(NSEvent.mouseLocation) else { return }
            self.hide()
        }
        if pinned { show() }
    }

    // Opening the app again (Finder, Spotlight, Launchpad) while it's already running: slide the column out,
    // instead of doing nothing visible (it has no Dock icon or window to bring forward).
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // the pointer is wherever you clicked the icon, not on the column: without the hold it slides right back out
        holdUntil = Date().addingTimeInterval(4)
        NSApp.activate(ignoringOtherApps: true)
        show(focus: true)
        return false
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
        if #available(macOS 13.3, *) { web.isInspectable = true }   // Safari → Develop → this Mac → GoodComments, to debug the board
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
        if editing { panel.makeKey(); panel.makeFirstResponder(web); return }
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
            // the panel only moves: redrawing the page at every step of the slide made it stutter
            panel.animator().setFrame(shownFrame(s), display: false)
        }
        if focus {
            panel.makeKey(); panel.makeFirstResponder(web)
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
        backFromEditor = false
        let s = panel.screen ?? screenUnderPointer()
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.24
            ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().setFrame(hiddenFrame(s), display: false)
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
        if backFromEditor {
            // the pointer is still where the big window was: wait for it to come back to the column
            if panel.frame.contains(p) { backFromEditor = false }
            awaySince = nil; return
        }
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
        let edit = NSMenu(title: L("Edit"))
        edit.addItem(withTitle: L("Undo"), action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: L("Redo"), action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: L("Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: L("Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: L("Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: L("Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
    }

    // MARK: menu bar

    func buildMenu() {
        if statusItem == nil {
            statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            statusItem.button?.image = Self.monkeyTemplate()
            statusItem.button?.imagePosition = .imageLeading
        }
        let menu = NSMenu()
        let showItem = NSMenuItem(title: L("Show comments"), action: #selector(toggle), keyEquivalent: "c")
        showItem.keyEquivalentModifierMask = [.control, .option]
        menu.addItem(showItem)
        let quickItem = NSMenuItem(title: L("New comment…"), action: #selector(openQuickFromMenu), keyEquivalent: "n")
        quickItem.keyEquivalentModifierMask = [.control, .option]
        menu.addItem(quickItem)
        menu.addItem(NSMenuItem(title: L("Minimize"), action: #selector(minimize), keyEquivalent: ""))
        let shotItem = NSMenuItem(title: L("Take a screenshot…"), action: #selector(captureFromMenu), keyEquivalent: "s")
        shotItem.keyEquivalentModifierMask = [.control, .option]
        menu.addItem(shotItem)
        pinItem = NSMenuItem(title: L("Keep open"), action: #selector(togglePin), keyEquivalent: "")
        pinItem.state = pinned ? .on : .off
        menu.addItem(pinItem)
        menu.addItem(NSMenuItem(title: L("Open in browser"), action: #selector(openBrowser), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: L("Reload"), action: #selector(reload), keyEquivalent: "r"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: L("Quit GoodComments"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
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

    /// Light / dark / system, from the board's Settings: the glass follows, and so does the other web view.
    func applyTheme(_ theme: String, from sender: WKWebView?) {
        let appearance: NSAppearance? = theme == "dark" ? NSAppearance(named: .darkAqua) : theme == "light" ? NSAppearance(named: .aqua) : nil
        if NSApp.appearance != appearance { NSApp.appearance = appearance }
        for other in [web, quickWeb].compactMap({ $0 }) where other !== sender {
            other.evaluateJavaScript("window.gcTheme && gcTheme('\(theme)')", completionHandler: nil)
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "togglePin": togglePin()
        case "minimize": minimize()
        case "capture":
            if message.webView === quickWeb { captureForQuick() } else { capture(target: (body["target"] as? String) ?? "composer") }
        case "editorOpen": if message.webView === quickWeb { enterQuickEditor() } else { enterEditor() }
        case "editorClose": if message.webView === quickWeb { exitQuickEditor() } else { exitEditor() }
        case "moved": if let id = body["id"] as? Int { ownMoves[id] = Date() }
        case "quickDone", "quickCancel": hideQuick()
        case "theme": applyTheme((body["theme"] as? String) ?? "system", from: message.webView)
        case "language": setLanguage((body["language"] as? String) ?? "auto")
        case "chooseFolder": chooseFolder(for: message.webView)
        case "quickSize": if let h = body["height"] as? Double { fitQuick(to: CGFloat(h)) }
        default: break
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { pushState() }

    @objc func openBrowser() { NSWorkspace.shared.open(URL(string: base)!) }
    @objc func reload() { loadBoard() }

    func loadBoard() {
        fixedSeen = nil
        quickLoaded = false
        ensureServer { [weak self] ok in
            guard let self else { return }
            if ok { self.web.load(URLRequest(url: URL(string: "\(base)/?embed=1")!)); self.pollToCheck() }
            else { self.web.loadHTMLString(Self.offlineHTML, baseURL: nil); self.updateToCheck(nil) }
        }
    }

    /// The project dialog's Choose… button: a folder picker; the path goes back to the page.
    func chooseFolder(for target: WKWebView?) {
        let open = NSOpenPanel()
        open.canChooseDirectories = true
        open.canChooseFiles = false
        open.allowsMultipleSelection = false
        open.canCreateDirectories = true
        open.prompt = L("Choose")
        open.message = L("Choose the project’s folder")
        picking = true
        NSApp.activate(ignoringOtherApps: true)
        open.begin { [weak self] response in
            guard let self else { return }
            self.picking = false
            self.holdUntil = Date().addingTimeInterval(4)
            if response == .OK, let path = open.url?.path,
               let data = try? JSONSerialization.data(withJSONObject: [path]), let json = String(data: data, encoding: .utf8) {
                (target ?? self.web).evaluateJavaScript("window.gcFolderChosen && gcFolderChosen(\(json)[0])")
            }
            self.panel.makeKey(); self.panel.makeFirstResponder(self.web)
        }
    }

    /// The board's language changed (or the page says which it is): menus in that language.
    func setLanguage(_ pref: String) {
        let before = appLanguage()
        UserDefaults.standard.set(["en", "es"].contains(pref) ? pref : "auto", forKey: "language")
        guard appLanguage() != before else { return }
        buildEditMenu()
        buildMenu()
    }

    // MARK: global hotkey ⌃⌥C (Carbon hotkeys need no permissions)

    var shotKey: EventHotKeyRef?
    var quickKey: EventHotKeyRef?

    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var hk = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            DispatchQueue.main.async {
                switch hk.id {
                case 2: delegate.capture(target: "composer")
                case 3: delegate.openQuick()
                default: delegate.toggle()
                }
            }
            return noErr
        }, 1, &spec, nil, nil)
        let sig = OSType(0x4743_4D54) // "GCMT"
        RegisterEventHotKey(UInt32(kVK_ANSI_C), UInt32(controlKey | optionKey), EventHotKeyID(signature: sig, id: 1), GetApplicationEventTarget(), 0, &hotKey)
        RegisterEventHotKey(UInt32(kVK_ANSI_S), UInt32(controlKey | optionKey), EventHotKeyID(signature: sig, id: 2), GetApplicationEventTarget(), 0, &shotKey)
        RegisterEventHotKey(UInt32(kVK_ANSI_N), UInt32(controlKey | optionKey), EventHotKeyID(signature: sig, id: 3), GetApplicationEventTarget(), 0, &quickKey)
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
        panel.makeKey(); panel.makeFirstResponder(web)
    }

    /// Back to the column at the edge.
    func exitEditor() {
        guard editing else { return }
        editing = false
        backFromEditor = true
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
                let safeTarget = ["ask", "edit"].contains(target) ? target : "composer"   // only these reach the page
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

    // MARK: quick capture (⌃⌥N, and "Send to GoodComments" in the Services menu)

    var quickEditing = false               // the drawing editor is open in the ⌃⌥N window
    var quickFrameBeforeEditor: NSRect?

    /// ⌃⌥N's camera: the window steps aside while you pick an area, then the drawing tools open in it.
    func captureForQuick() {
        picking = true                       // it went away on purpose: don't treat that as "clicked elsewhere"
        quick.orderOut(nil)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("goodcomments-\(UUID().uuidString).png")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-i", "-x", url.path]
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                NSApp.activate(ignoringOtherApps: true)
                self.quick.makeKeyAndOrderFront(nil)
                self.quick.makeFirstResponder(self.quickWeb)
                self.picking = false
                if let data = try? Data(contentsOf: url), !data.isEmpty {
                    try? FileManager.default.removeItem(at: url)
                    self.quickWeb.evaluateJavaScript("window.gcScreenshot && gcScreenshot('data:image/png;base64,\(data.base64EncodedString())', 'composer')")
                } else {
                    self.quickWeb.evaluateJavaScript("window.gcScreenshot && gcScreenshot(null, 'composer')")
                }
            }
        }
        do { try p.run() } catch { picking = false; quick.makeKeyAndOrderFront(nil) }
    }

    /// Drawing on a screenshot needs room: the ⌃⌥N window grows into a big one in the middle, then comes back.
    func enterQuickEditor() {
        guard !quickEditing else { return }
        quickEditing = true
        quickFrameBeforeEditor = quick.frame
        let v = (quick.screen ?? screenUnderPointer()).visibleFrame
        let w = min(v.width * 0.84, 1500)
        let h = min(v.height * 0.88, 1050)
        quick.setFrame(NSRect(x: v.midX - w / 2, y: v.midY - h / 2, width: w, height: h), display: true, animate: true)
        NSApp.activate(ignoringOtherApps: true)
        quick.makeKey(); quick.makeFirstResponder(quickWeb)
    }

    func exitQuickEditor() {
        guard quickEditing else { return }
        quickEditing = false
        if let f = quickFrameBeforeEditor { quick.setFrame(f, display: true, animate: true) }
        quick.invalidateShadow()
        quick.makeKey(); quick.makeFirstResponder(quickWeb)
    }

    /// A small floating window near the top of the screen with only the composer (the page in ?quick=1 mode).
    func buildQuick() {
        quick = EdgePanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: quickHeight),
                          styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        quick.level = .floating
        quick.isOpaque = false
        quick.backgroundColor = .clear
        quick.hasShadow = true
        quick.hidesOnDeactivate = false
        quick.isMovableByWindowBackground = true
        quick.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let glass = NSVisualEffectView()
        glass.material = .popover
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.wantsLayer = true
        glass.layer?.cornerRadius = 16
        glass.layer?.masksToBounds = true
        glass.layer?.borderWidth = 0.5
        glass.layer?.borderColor = NSColor.white.withAlphaComponent(0.35).cgColor
        glass.maskImage = Self.roundedMask(16)   // a floating window shows its corners: cut the glass itself, not just its layer
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "gc")
        quickWeb = WKWebView(frame: .zero, configuration: config)
        if #available(macOS 13.3, *) { quickWeb.isInspectable = true }
        quickWeb.wantsLayer = true
        quickWeb.layer?.cornerRadius = 16
        quickWeb.layer?.masksToBounds = true
        quickWeb.setValue(false, forKey: "drawsBackground")
        quickWeb.underPageBackgroundColor = .clear
        quickWeb.navigationDelegate = self
        quickWeb.uiDelegate = self
        quickWeb.autoresizingMask = [.width, .height]
        quick.web = quickWeb
        glass.addSubview(quickWeb)
        quick.contentView = glass
        quickWeb.frame = glass.bounds
        NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: quick, queue: .main) { [weak self] _ in
            // click elsewhere: it goes away, like Spotlight (what you typed stays for next time)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                guard let self, !self.quick.isKeyWindow, !self.picking else { return }
                self.quick.orderOut(nil)
            }
        }
    }

    @objc func openQuickFromMenu() { openQuick() }

    func openQuick(text: String? = nil) {
        let s = screenUnderPointer().visibleFrame
        quick.setFrame(NSRect(x: s.midX - 280, y: s.maxY - quickHeight - s.height * 0.18, width: 560, height: quickHeight), display: true)
        quick.invalidateShadow()
        // a non-activating panel takes the keyboard without pulling you out of the app you're in
        quick.makeKeyAndOrderFront(nil)
        quick.makeFirstResponder(quickWeb)
        if !quickLoaded {
            ensureServer { [weak self] ok in
                guard let self else { return }
                var c = URLComponents(string: "\(base)/")!
                c.queryItems = [URLQueryItem(name: "quick", value: "1")] + (text.map { [URLQueryItem(name: "text", value: $0)] } ?? [])
                if ok { self.quickWeb.load(URLRequest(url: c.url!)); self.quickLoaded = true }
                else { self.quickWeb.loadHTMLString(Self.offlineHTML, baseURL: nil) }
            }
            return
        }
        // pass the text as JSON so quotes and newlines arrive intact
        if let text, let data = try? JSONSerialization.data(withJSONObject: ["text": text]), let json = String(data: data, encoding: .utf8) {
            quickWeb.evaluateJavaScript("window.gcQuick && gcQuick(\(json))")
        } else {
            quickWeb.evaluateJavaScript("window.gcQuick && gcQuick({ text: document.getElementById('c-body').value })")
        }
    }

    func hideQuick() { quick.orderOut(nil) }

    /// The ⌃⌥N window follows its content (long text, attachments), growing downwards from where it is.
    func fitQuick(to height: CGFloat) {
        guard !quickEditing, let s = quick.screen ?? NSScreen.main else { return }
        let h = min(max(height, quickHeight), s.visibleFrame.height * 0.7)
        var f = quick.frame
        guard abs(f.height - h) > 1 else { return }
        f.origin.y = max(s.visibleFrame.minY + 8, f.maxY - h)
        f.size.height = h
        quick.setFrame(f, display: true, animate: false)
        quick.invalidateShadow()
    }

    /// Services menu → "Send to GoodComments": the quick window, with the selected text in it.
    @objc func sendToGoodComments(_ pboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
        let text = pboard.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        DispatchQueue.main.async { self.openQuick(text: text) }
    }

    // MARK: To check: menu bar count and notifications

    /// Every few seconds: how many comments wait in To check (shown next to the monkey), and a notification
    /// for each one that someone else (an agent, the CLI) just marked fixed.
    func pollToCheck() {
        var req = URLRequest(url: URL(string: "\(base)/api/comments?status=fixed&limit=1000")!)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { [weak self] data, res, _ in
            let list = (res as? HTTPURLResponse)?.statusCode == 200
                ? (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]]) : nil
            DispatchQueue.main.async { self?.updateToCheck(list) }
        }.resume()
    }

    func updateToCheck(_ list: [[String: Any]]?) {
        guard let list else { statusItem.button?.title = ""; return }
        let n = list.count
        statusItem.button?.title = n > 0 ? " \(n)" : ""
        statusItem.button?.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        statusItem.button?.toolTip = n > 0 ? "\(n) to check" : "GoodComments"

        var now: [Int: String] = [:]
        for c in list { if let id = c["id"] as? Int { now[id] = c["fixed_at"] as? String ?? "" } }
        defer { fixedSeen = now }
        guard let seen = fixedSeen else { return }   // first poll: don't announce what was already there
        ownMoves = ownMoves.filter { Date().timeIntervalSince($0.value) < 120 }
        for c in list {
            guard let id = c["id"] as? Int, seen[id] != now[id], ownMoves[id] == nil else { continue }
            notifyFixed(c)
        }
    }

    func notifyFixed(_ c: [String: Any]) {
        guard let id = c["id"] as? Int else { return }
        let content = UNMutableNotificationContent()
        let body = (c["body"] as? String ?? "").split(separator: "\n").first.map(String.init) ?? ""
        content.title = body.count > 70 ? String(body.prefix(69)) + "…" : body
        var subtitle = L("Ready to check")
        if let who = c["fixed_by"] as? String, !who.isEmpty, who != "you" { subtitle = L("Fixed by ") + who }
        if let p = c["project_name"] as? String { subtitle += " · \(p)" }
        content.subtitle = subtitle
        content.body = c["fix_note"] as? String ?? ""
        content.sound = .default
        content.userInfo = ["id": id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "fixed-\(id)", content: content, trigger: nil))
    }

    /// Click a notification: the column slides in with that card in focus.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["id"] as? Int
        DispatchQueue.main.async {
            self.holdUntil = Date().addingTimeInterval(4)
            self.show(focus: false)
            NSApp.activate(ignoringOtherApps: true)
            self.panel.makeKey(); self.panel.makeFirstResponder(self.web)
            if let id { self.web.evaluateJavaScript("window.gcFocus && gcFocus(\(id))") }
        }
        done()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
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

    /// Where server/index.js lives: next to the app (a repo build or Homebrew), or wherever the installer
    /// said (an app copied to ~/Applications). A saved path is only trusted if it still exists.
    static func findRoot() -> String? {
        let fm = FileManager.default
        let hasServer = { (path: String) in fm.fileExists(atPath: (path as NSString).appendingPathComponent("server/index.js")) }
        if let env = ProcessInfo.processInfo.environment["GOODCOMMENTS_HOME"], hasServer(env) { return env }
        var url = Bundle.main.bundleURL.resolvingSymlinksInPath()
        for _ in 0..<6 {
            url.deleteLastPathComponent()
            if hasServer(url.path) { return url.path }
        }
        if let saved = UserDefaults.standard.string(forKey: "root"), hasServer(saved) { return saved }
        return nil
    }

    /// A stretchable rounded rectangle for NSVisualEffectView.maskImage.
    static func roundedMask(_ r: CGFloat) -> NSImage {
        let img = NSImage(size: NSSize(width: r * 2 + 1, height: r * 2 + 1), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).fill()
            return true
        }
        img.capInsets = NSEdgeInsets(top: r, left: r, bottom: r, right: r)
        img.resizingMode = .stretch
        return img
    }

    /// The logo's monkey in ink lines, hanging from its twig, drawn as a menu bar template (adapts to light/dark).
    static func monkeyTemplate() -> NSImage {
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
            NSColor.black.setFill()
            NSColor.black.setStroke()
            func line(_ w: CGFloat, _ draw: (NSBezierPath) -> Void) {
                let p = NSBezierPath(); p.lineWidth = w; p.lineCapStyle = .round; p.lineJoinStyle = .round
                draw(p); p.stroke()
            }
            line(1.4) { p in p.move(to: NSPoint(x: 1.2, y: 3.4)); p.curve(to: NSPoint(x: 16.8, y: 2.8), controlPoint1: NSPoint(x: 6, y: 4), controlPoint2: NSPoint(x: 11, y: 2.4)) }  // twig
            line(1.3) { p in p.move(to: NSPoint(x: 6.6, y: 9)); p.curve(to: NSPoint(x: 5.6, y: 3.6), controlPoint1: NSPoint(x: 5.4, y: 7.4), controlPoint2: NSPoint(x: 5.1, y: 5.4)) }  // arms
            line(1.3) { p in p.move(to: NSPoint(x: 11.4, y: 9)); p.curve(to: NSPoint(x: 12.4, y: 3.4), controlPoint1: NSPoint(x: 12.6, y: 7.4), controlPoint2: NSPoint(x: 12.9, y: 5.4)) }
            line(1.2) { p in p.appendOval(in: NSRect(x: 2.2, y: 10, width: 3.4, height: 3.4)) }  // ears
            line(1.2) { p in p.appendOval(in: NSRect(x: 12.4, y: 10, width: 3.4, height: 3.4)) }
            let head = NSRect(x: 4.3, y: 7.2, width: 9.4, height: 9.6)
            NSGraphicsContext.current?.compositingOperation = .destinationOut                 // the head covers the ears and arms
            NSBezierPath(ovalIn: head).fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            line(1.3) { p in p.appendOval(in: head.insetBy(dx: 0.65, dy: 0.65)) }
            NSBezierPath(ovalIn: NSRect(x: 6.6, y: 10.6, width: 1.5, height: 1.5)).fill()     // eyes
            NSBezierPath(ovalIn: NSRect(x: 9.9, y: 10.6, width: 1.5, height: 1.5)).fill()
            line(1.0) { p in p.move(to: NSPoint(x: 7.1, y: 13.4)); p.curve(to: NSPoint(x: 10.9, y: 13.4), controlPoint1: NSPoint(x: 8.2, y: 14.9), controlPoint2: NSPoint(x: 9.8, y: 14.9)) }  // smile
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
        open.message = L("Attach screenshots or documents")
        open.prompt = L("Attach")
        picking = true
        // the paperclip in the column or in the ⌃⌥N window: that window stays, and gets the keyboard back
        let window: NSWindow = webView === quickWeb ? quick : panel
        NSApp.activate(ignoringOtherApps: true)
        window.makeKey(); window.makeFirstResponder(webView)
        open.begin { [weak self] response in
            completionHandler(response == .OK ? open.urls : nil)
            guard let self else { return }
            self.picking = false
            self.holdUntil = Date().addingTimeInterval(4)   // give you time to write the comment
            window.makeKey(); window.makeFirstResponder(webView)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: L("Cancel"))
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
