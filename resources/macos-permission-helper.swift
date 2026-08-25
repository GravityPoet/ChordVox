//
// macos-permission-helper.swift
//
// Native macOS drag-to-grant permission helper for ChordVox.
//
// Renders a small floating guide card next to System Settings. The card hosts a
// draggable app-icon "chip" that the user drags directly into the Accessibility
// (or Screen Recording) list to write the TCC grant — the same one-gesture flow
// users praise in Codex Computer Use / riko2chen's AskForPermission (MIT).
//
// Why native instead of an Electron BrowserWindow:
//   An Electron transparent/`type:"panel"` window shown with `showInactive()` is
//   a non-key, non-active window. While System Settings is the key app, macOS
//   routes the click that STARTS a drag (and clicks on the panel buttons) to
//   System Settings, not the panel — so the drag never begins and the buttons
//   look dead. A native `NSPanel` with `.nonactivatingPanel` receives mouse and
//   drag-initiation events without stealing key focus from System Settings,
//   which is exactly what makes the AskForPermission flow feel solid.
//
// Protocol (stdout, newline-delimited): READY, GRANTED, CLOSED.
// The parent (Electron) reads these and manages lifecycle; SIGTERM or parent
// death (getppid()==1) terminates the helper.
//
// Credit: drag-to-grant recipe adapted from riko2chen/AskForPermission (MIT).
//

import Cocoa
import Foundation
import Darwin
import ApplicationServices
import CoreGraphics

// MARK: - Argument parsing

func argValue(_ key: String, default def: String = "") -> String {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: key), i + 1 < args.count {
        return args[i + 1]
    }
    return def
}

let permissionKind = argValue("--kind", default: "accessibility")          // accessibility | screenRecording
let bundlePath = argValue("--bundle")                                       // /path/to/ChordVox.app
let appName = argValue("--app-name", default: "ChordVox")
let cardTitle = argValue("--title", default: "授权辅助功能")
let cardDescription = argValue("--description", default: "把下方图标拖进列表即可授权")
let dragHint = argValue("--drag-hint", default: "拖我到列表里")
let unavailableLabel = argValue("--unavailable-label", default: "先把当前 ChordVox 安装到“应用程序”")
let settingsLabel = argValue("--reveal-label", default: "打开辅助功能")
let closeLabel = argValue("--close-label", default: "关闭")
let grantedTextArg = argValue("--granted-label")
let grantedText = grantedTextArg.isEmpty ? "✓" : grantedTextArg
let canDrag = argValue("--can-drag", default: "1") != "0" && !bundlePath.isEmpty

// MARK: - stdout protocol

func emit(_ line: String) {
    if let data = (line + "\n").data(using: .utf8) {
        FileHandle.standardOutput.write(data)
    }
    fflush(stdout)
}

// Grant DETECTION is parent-driven: only the ChordVox process can truthfully
// query its OWN TCC trust (AXIsProcessTrusted / isTrustedAccessibilityClient
// report the *calling* process, which for this separate helper binary would be
// meaningless). Electron watches its own permission and signals us over stdin:
//   "GRANTED" -> success flash then exit;  "CLOSE" -> exit.
// stdin EOF (parent died) or getppid()==1 also triggers self-destruct.

// MARK: - Colors

extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1.0) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xff) / 255.0,
            green: CGFloat((hex >> 8) & 0xff) / 255.0,
            blue: CGFloat(hex & 0xff) / 255.0,
            alpha: alpha
        )
    }
}

enum Palette {
    static let cardBg = NSColor(hex: 0xfbf7ef)
    static let textPrimary = NSColor(hex: 0x2b2540)
    static let textSecondary = NSColor(hex: 0x6f6880)
    static let textTertiary = NSColor(hex: 0x9a93a8)
    static let accent = NSColor(hex: 0x6d63f6)
    static let accentSoft = NSColor(hex: 0x6d63f6, alpha: 0.08)
    static let border = NSColor(hex: 0x000000, alpha: 0.08)
    static let granted = NSColor(hex: 0x1f9d57)
    static let warning = NSColor(hex: 0xd92d20)
}

// MARK: - Flipped container (top-down layout)

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - First-mouse button (clickable while another app is key)

final class FirstMouseButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - Draggable app-icon chip (NSURL pasteboard writer -> .copy)

final class DraggableAppIconView: NSView, NSDraggingSource {
    private let bundleURL: URL
    private let enabled: Bool
    private var mouseDownEvent: NSEvent?
    private let dragThreshold: CGFloat = 3.0

    var showGranted = false {
        didSet { needsDisplay = true }
    }

    init(frame: NSRect, bundleURL: URL, enabled: Bool) {
        self.bundleURL = bundleURL
        self.enabled = enabled
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

    // hitTest receives `point` in the superview's coordinate space, so the
    // containment check must use `frame` (not `bounds`) to claim the whole chip.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard enabled, !isHidden, alphaValue > 0, frame.contains(point) else {
            return super.hitTest(point)
        }
        return self
    }

    // While drag-enabled, claim mouse-downs so the panel's
    // isMovableByWindowBackground cannot turn an in-chip press into a window move.
    override var mouseDownCanMoveWindow: Bool { !enabled }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { enabled }

    override func resetCursorRects() {
        if enabled {
            addCursorRect(bounds, cursor: .openHand)
        }
    }

    // Dashed rounded "drop here" affordance; solid green once granted.
    override func draw(_ dirtyRect: NSRect) {
        let inset = bounds.insetBy(dx: 1.5, dy: 1.5)
        let radius: CGFloat = 14

        if showGranted {
            let bg = NSBezierPath(roundedRect: inset, xRadius: radius, yRadius: radius)
            Palette.granted.withAlphaComponent(0.10).setFill()
            bg.fill()
            let border = NSBezierPath(roundedRect: inset, xRadius: radius, yRadius: radius)
            border.lineWidth = 1.5
            Palette.granted.setStroke()
            border.stroke()
            return
        }

        let bg = NSBezierPath(roundedRect: inset, xRadius: radius, yRadius: radius)
        Palette.accentSoft.setFill()
        bg.fill()

        let border = NSBezierPath(roundedRect: inset, xRadius: radius, yRadius: radius)
        border.lineWidth = 1.5
        border.setLineDash([6, 4], count: 2, phase: 0)
        Palette.accent.withAlphaComponent(enabled ? 0.9 : 0.35).setStroke()
        border.stroke()
    }

    override func mouseDown(with event: NSEvent) {
        guard enabled else { return }
        mouseDownEvent = event
    }

    override func mouseDragged(with event: NSEvent) {
        guard enabled, let down = mouseDownEvent else { return }
        let dx = event.locationInWindow.x - down.locationInWindow.x
        let dy = event.locationInWindow.y - down.locationInWindow.y
        if (dx * dx + dy * dy).squareRoot() < dragThreshold { return }

        let icon = NSWorkspace.shared.icon(forFile: bundleURL.path)
        let dragSize = NSSize(width: 64, height: 64)
        icon.size = dragSize

        let item = NSDraggingItem(pasteboardWriter: bundleURL as NSURL)
        let origin = convert(down.locationInWindow, from: nil)
        let frame = NSRect(x: origin.x - dragSize.width / 2,
                           y: origin.y - dragSize.height / 2,
                           width: dragSize.width,
                           height: dragSize.height)
        item.setDraggingFrame(frame, contents: icon)

        let session = beginDraggingSession(with: [item], event: down, source: self)
        session.animatesToStartingPositionsOnCancelOrFail = true
        mouseDownEvent = nil
    }

    override func mouseUp(with event: NSEvent) {
        mouseDownEvent = nil
    }

    // Copy for drops outside our app (System Settings); none inside.
    func draggingSession(_ session: NSDraggingSession,
                         sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        return context == .outsideApplication ? .copy : []
    }
}

// MARK: - Controller

final class PermissionHelperController: NSObject, NSApplicationDelegate {
    private var panel: NSPanel!
    private var lifecycleTimer: Timer?
    private var granted = false
    private var closing = false
    private var stdinBuffer = ""

    // UI refs mutated on grant (success flash)
    private weak var chipView: DraggableAppIconView?
    private weak var chipLabel: NSTextField?
    private weak var chipGlyph: NSView?
    private weak var hintLabel: NSTextField?

    // Layout constants
    private let cardWidth: CGFloat = 360
    private let cardHeight: CGFloat = 274
    private let shadowMargin: CGFloat = 12
    private let pad: CGFloat = 16

    private var panelWidth: CGFloat { cardWidth + shadowMargin * 2 }
    private var panelHeight: CGFloat { cardHeight + shadowMargin * 2 }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildPanel()
        positionPanel()
        panel.orderFrontRegardless()
        emit("READY")
        startStdinReader()
        startLifecycleWatch()
    }

    // MARK: Build UI

    private func buildPanel() {
        let panelRect = NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight)
        let cardRect = NSRect(x: shadowMargin, y: shadowMargin, width: cardWidth, height: cardHeight)
        panel = NSPanel(
            contentRect: panelRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false

        let root = FlippedView(frame: panelRect)
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.clear.cgColor
        panel.contentView = root

        // Rounded card background
        let card = FlippedView(frame: cardRect)
        card.wantsLayer = true
        card.layer?.backgroundColor = Palette.cardBg.cgColor
        card.layer?.cornerRadius = 18
        card.layer?.masksToBounds = false
        card.layer?.borderWidth = 1
        card.layer?.borderColor = Palette.border.cgColor
        card.layer?.shadowColor = NSColor.black.cgColor
        card.layer?.shadowOpacity = 0.20
        card.layer?.shadowRadius = 18
        card.layer?.shadowOffset = CGSize(width: 0, height: -5)
        card.layer?.shadowPath = CGPath(
            roundedRect: card.bounds,
            cornerWidth: 18,
            cornerHeight: 18,
            transform: nil
        )
        root.addSubview(card)

        let contentWidth = cardWidth - pad * 2

        // App icon (top-left)
        let iconSize: CGFloat = 42
        let iconView = NSImageView(frame: NSRect(x: pad, y: pad, width: iconSize, height: iconSize))
        iconView.imageScaling = .scaleProportionallyUpOrDown
        if !bundlePath.isEmpty {
            iconView.image = NSWorkspace.shared.icon(forFile: bundlePath)
        } else {
            iconView.image = NSApp.applicationIconImage
        }
        iconView.wantsLayer = true
        iconView.layer?.cornerRadius = 9
        iconView.layer?.masksToBounds = true
        card.addSubview(iconView)

        // Title
        let titleX = pad + iconSize + 12
        let titleLabel = makeLabel(
            frame: NSRect(x: titleX, y: pad + 1, width: cardWidth - titleX - pad - 30, height: 22),
            text: cardTitle, size: 15, weight: .bold, color: Palette.textPrimary
        )
        card.addSubview(titleLabel)

        // Close button (top-right circle)
        let closeSize: CGFloat = 26
        let closeBtn = FirstMouseButton(frame: NSRect(x: cardWidth - pad - closeSize, y: pad - 2,
                                                      width: closeSize, height: closeSize))
        closeBtn.bezelStyle = .regularSquare
        closeBtn.isBordered = false
        closeBtn.wantsLayer = true
        closeBtn.layer?.cornerRadius = closeSize / 2
        closeBtn.layer?.backgroundColor = NSColor(hex: 0x000000, alpha: 0.05).cgColor
        closeBtn.attributedTitle = NSAttributedString(
            string: "✕",
            attributes: [
                .foregroundColor: Palette.textSecondary,
                .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
            ]
        )
        closeBtn.toolTip = closeLabel
        closeBtn.target = self
        closeBtn.action = #selector(onClose)
        card.addSubview(closeBtn)

        // Important instruction. If the localized description has two lines,
        // the first line is emphasized as the must-do step for unsigned builds.
        let descY = pad + iconSize + 4
        var descriptionBlockHeight: CGFloat = 54
        let descriptionParts = cardDescription.split(
            separator: "\n",
            maxSplits: 1,
            omittingEmptySubsequences: false
        ).map(String.init)
        let primaryDescription = descriptionParts.first ?? cardDescription
        let secondaryDescription = descriptionParts.count > 1 ? descriptionParts[1] : ""

        if secondaryDescription.isEmpty {
            let descLabel = makeLabel(
                frame: NSRect(x: pad, y: descY, width: contentWidth, height: 48),
                text: primaryDescription, size: 12, weight: .regular, color: Palette.textSecondary
            )
            descLabel.maximumNumberOfLines = 3
            descLabel.lineBreakMode = .byWordWrapping
            descLabel.cell?.usesSingleLineMode = false
            descLabel.cell?.wraps = true
            descLabel.cell?.truncatesLastVisibleLine = false
            card.addSubview(descLabel)
        } else {
            descriptionBlockHeight = 72
            let warningLabel = makeLabel(
                frame: NSRect(x: pad, y: descY, width: contentWidth, height: 20),
                text: primaryDescription, size: 13.5, weight: .bold, color: Palette.warning
            )
            card.addSubview(warningLabel)

            let descLabel = makeLabel(
                frame: NSRect(x: pad, y: descY + 24, width: contentWidth, height: 44),
                text: secondaryDescription, size: 12, weight: .regular, color: Palette.textSecondary
            )
            descLabel.maximumNumberOfLines = 3
            descLabel.lineBreakMode = .byWordWrapping
            descLabel.cell?.usesSingleLineMode = false
            descLabel.cell?.wraps = true
            descLabel.cell?.truncatesLastVisibleLine = false
            card.addSubview(descLabel)
        }

        // Drag chip
        let chipY = descY + descriptionBlockHeight
        let chipHeight: CGFloat = 64
        let chip = DraggableAppIconView(
            frame: NSRect(x: pad, y: chipY, width: contentWidth, height: chipHeight),
            bundleURL: URL(fileURLWithPath: bundlePath.isEmpty ? "/" : bundlePath),
            enabled: canDrag
        )
        card.addSubview(chip)
        chipView = chip

        // Chip contents: small icon + drag hint label + glyph
        let chipIconSize: CGFloat = 38
        let chipIcon = NSImageView(frame: NSRect(x: 14, y: (chipHeight - chipIconSize) / 2,
                                                 width: chipIconSize, height: chipIconSize))
        chipIcon.imageScaling = .scaleProportionallyUpOrDown
        chipIcon.image = bundlePath.isEmpty ? NSApp.applicationIconImage
            : NSWorkspace.shared.icon(forFile: bundlePath)
        chipIcon.wantsLayer = true
        chipIcon.layer?.cornerRadius = 8
        chipIcon.layer?.masksToBounds = true
        chip.addSubview(chipIcon)

        let chipTextX = 14 + chipIconSize + 12
        let chipLabel = makeLabel(
            frame: NSRect(x: chipTextX, y: (chipHeight - 34) / 2, width: contentWidth - chipTextX - 34, height: 34),
            text: canDrag ? dragHint : unavailableLabel,
            size: 12.5, weight: .semibold,
            color: canDrag ? Palette.accent : Palette.textTertiary
        )
        chipLabel.maximumNumberOfLines = 2
        chipLabel.lineBreakMode = .byWordWrapping
        chipLabel.cell?.usesSingleLineMode = false
        chipLabel.cell?.wraps = true
        chipLabel.cell?.truncatesLastVisibleLine = false
        chip.addSubview(chipLabel)
        self.chipLabel = chipLabel

        if canDrag {
            if let plusImage = NSImage(systemSymbolName: "plus.circle.fill", accessibilityDescription: "Add") {
                let glyphImage = NSImageView(
                    frame: NSRect(x: contentWidth - 34, y: (chipHeight - 24) / 2, width: 24, height: 24)
                )
                glyphImage.image = plusImage
                glyphImage.contentTintColor = Palette.accent
                glyphImage.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 18, weight: .bold)
                chip.addSubview(glyphImage)
                self.chipGlyph = glyphImage
            } else {
                let glyph = makeLabel(
                    frame: NSRect(x: contentWidth - 34, y: (chipHeight - 24) / 2, width: 24, height: 24),
                    text: "＋", size: 18, weight: .bold, color: Palette.accent
                )
                glyph.alignment = .center
                chip.addSubview(glyph)
                self.chipGlyph = glyph
            }
        }

        // Hint line under chip
        let hintY = chipY + chipHeight + 8
        let hintLabel = makeLabel(
            frame: NSRect(x: pad, y: hintY, width: contentWidth, height: 16),
            text: canDrag ? "松开鼠标即完成授权" : "",
            size: 11, weight: .regular, color: Palette.textTertiary
        )
        hintLabel.alignment = .center
        card.addSubview(hintLabel)
        self.hintLabel = hintLabel

        // Settings button (secondary, bottom)
        let settingsH: CGFloat = 30
        let settingsY = hintY + 24
        let settingsBtn = FirstMouseButton(frame: NSRect(x: pad, y: settingsY, width: contentWidth, height: settingsH))
        settingsBtn.bezelStyle = .regularSquare
        settingsBtn.isBordered = false
        settingsBtn.wantsLayer = true
        settingsBtn.layer?.cornerRadius = 9
        settingsBtn.layer?.backgroundColor = NSColor(hex: 0x000000, alpha: 0.04).cgColor
        settingsBtn.layer?.borderWidth = 1
        settingsBtn.layer?.borderColor = Palette.border.cgColor
        settingsBtn.attributedTitle = NSAttributedString(
            string: settingsLabel,
            attributes: [
                .foregroundColor: Palette.textPrimary,
                .font: NSFont.systemFont(ofSize: 12.5, weight: .medium),
            ]
        )
        settingsBtn.target = self
        settingsBtn.action = #selector(onOpenSettings)
        card.addSubview(settingsBtn)
    }

    private func makeLabel(frame: NSRect, text: String, size: CGFloat,
                           weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let label = NSTextField(frame: frame)
        label.stringValue = text
        label.font = NSFont.systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.isEditable = false
        label.isSelectable = false
        label.isBordered = false
        label.drawsBackground = false
        label.backgroundColor = .clear
        label.lineBreakMode = .byTruncatingTail
        label.cell?.usesSingleLineMode = true
        return label
    }

    // MARK: Positioning (top-right of the screen the user is working on)

    private func positionPanel() {
        let mouseLocation = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: {
            NSMouseInRect(mouseLocation, $0.frame, false)
        }) ?? NSScreen.main else { return }
        let vf = screen.visibleFrame
        let margin: CGFloat = 24
        let x = vf.maxX - panelWidth - margin
        let y = vf.maxY - panelHeight - margin
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    // MARK: stdin command channel (parent -> helper)

    private func startStdinReader() {
        let handle = FileHandle.standardInput
        handle.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty {
                // EOF: parent closed the pipe (died) -> self-destruct.
                DispatchQueue.main.async { self?.terminate() }
                return
            }
            guard let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.consumeStdinText(text) }
        }
    }

    private func consumeStdinText(_ text: String) {
        stdinBuffer += text
        while let newlineRange = stdinBuffer.rangeOfCharacter(from: .newlines) {
            let raw = String(stdinBuffer[..<newlineRange.lowerBound])
            stdinBuffer.removeSubrange(..<newlineRange.upperBound)
            handleStdinCommand(raw)
        }
        if stdinBuffer.count > 1024 {
            stdinBuffer.removeAll()
        }
    }

    private func handleStdinCommand(_ raw: String) {
        let cmd = raw.trimmingCharacters(in: .whitespaces).uppercased()
        if cmd.isEmpty { return }
        if cmd == "GRANTED" {
            handleGranted()
        } else if cmd == "CLOSE" {
            terminate()
        }
    }

    // Success flash, then exit. Triggered by the parent's "GRANTED" command.
    private func handleGranted() {
        guard !granted else { return }
        granted = true
        chipView?.showGranted = true
        chipGlyph?.isHidden = true
        chipLabel?.stringValue = grantedText
        chipLabel?.textColor = Palette.granted
        hintLabel?.stringValue = ""
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
            self.terminate()
        }
    }

    // MARK: Parent-death / signal watch

    private func startLifecycleWatch() {
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            // Parent (Electron) gone -> reparented to launchd (ppid 1). Self-destruct.
            if getppid() == 1 {
                self?.terminate()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        lifecycleTimer = timer
    }

    // MARK: Actions

    @objc private func onClose() {
        emit("CLOSED")
        terminate()
    }

    @objc private func onOpenSettings() {
        let urlString = permissionKind == "screenRecording"
            ? "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            : "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        if let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
    }

    func terminate() {
        guard !closing else { return }
        closing = true
        FileHandle.standardInput.readabilityHandler = nil
        lifecycleTimer?.invalidate()
        panel?.orderOut(nil)
        NSApp.terminate(nil)
    }
}

// MARK: - Entry point

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let controller = PermissionHelperController()
app.delegate = controller

// SIGTERM -> graceful terminate (parent kill, mirrors globe listener).
let sigSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
sigSource.setEventHandler {
    controller.terminate()
}
sigSource.resume()

app.run()
