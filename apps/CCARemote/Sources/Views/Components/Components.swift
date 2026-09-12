import SwiftUI

struct StatusDot: View {
    var state: SessionState
    var body: some View {
        Circle()
            .fill(Theme.stateColor(state))
            .frame(width: 8, height: 8)
            .overlay {
                if state == .running || state == .starting {
                    Circle().stroke(Theme.coral.opacity(0.5), lineWidth: 3).scaleEffect(1.6)
                        .phaseAnimator([0.6, 1.0]) { view, phase in view.opacity(phase) } animation: { _ in .easeInOut(duration: 0.9) }
                }
            }
    }
}

struct LimitBar: View {
    var title: String
    var window: LimitWindow?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(title).font(.caption).foregroundStyle(Theme.secondary)
                Spacer()
                if let u = window?.utilization {
                    Text("\(Int(u * 100))%").font(.caption.monospacedDigit()).foregroundStyle(Theme.limitColor(u))
                } else {
                    Text("—").font(.caption).foregroundStyle(Theme.tertiary)
                }
                if let reset = window?.resetsAt {
                    Text("· \(reset.untilShort)").font(.caption).foregroundStyle(Theme.tertiary)
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.08))
                    Capsule()
                        .fill(Theme.limitColor(window?.utilization))
                        .frame(width: geo.size.width * min(1, max(0, window?.utilization ?? 0)))
                }
            }
            .frame(height: 5)
        }
    }
}

struct Chip: View {
    var systemImage: String?
    var text: String
    var tint: Color = Theme.secondary

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage { Image(systemName: systemImage).font(.caption2) }
            Text(text).font(.caption).lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Theme.cardRaised, in: Capsule())
    }
}

struct EmptyState: View {
    var title: String
    var subtitle: String
    var systemImage: String = "sparkles"

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage).font(.system(size: 34)).foregroundStyle(Theme.coral)
            Text(title).font(.title3.weight(.semibold))
            Text(subtitle).font(.subheadline).foregroundStyle(Theme.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: 360)
        .padding()
    }
}

/// Block-level markdown: fenced code, headings, bullet and numbered lists,
/// paragraphs; inline emphasis and code inside each via AttributedString.
struct MessageText: View {
    var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let content):
            inline(content).font(level == 1 ? .title2.weight(.semibold) : level == 2 ? .title3.weight(.semibold) : .headline).padding(.top, 4)
        case .paragraph(let content):
            inline(content)
        case .bullets(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(Theme.secondary)
                        inline(item)
                    }
                }
            }
        case .numbered(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(index + 1).").font(.body.monospacedDigit()).foregroundStyle(Theme.secondary)
                        inline(item)
                    }
                }
            }
        case .code(let lang, let code):
            VStack(alignment: .leading, spacing: 4) {
                if let lang, !lang.isEmpty { Text(lang).font(.caption2.weight(.semibold)).foregroundStyle(Theme.tertiary) }
                ScrollView(.horizontal) {
                    Text(code).font(.callout.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.black.opacity(0.4), in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.stroke))
        case .quote(let content):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(Theme.coral.opacity(0.6)).frame(width: 3)
                inline(content).foregroundStyle(Theme.secondary)
            }
        case .rule:
            Divider().overlay(Theme.stroke)
        case .table(let header, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    GridRow {
                        ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                            inline(cell).font(.caption.weight(.semibold)).foregroundStyle(Theme.secondary)
                        }
                    }
                    Divider().overlay(Theme.stroke).gridCellUnsizedAxes(.horizontal)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                inline(cell).font(.callout).lineLimit(3)
                            }
                        }
                    }
                }
                .padding(10)
            }
            .background(Theme.card, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.stroke))
        }
    }

    private func inline(_ content: String) -> Text {
        if let attributed = try? AttributedString(markdown: content, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return Text(attributed)
        }
        return Text(content)
    }
}

enum MarkdownBlock {
    case heading(Int, String)
    case paragraph(String)
    case bullets([String])
    case numbered([String])
    case code(String?, String)
    case quote(String)
    case rule
    case table(header: [String], rows: [[String]])

    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var numbered: [String] = []
        var code: [String]? = nil
        var codeLang: String? = nil
        var tableRows: [[String]] = []

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: " "))); paragraph = [] }
            if !bullets.isEmpty { blocks.append(.bullets(bullets)); bullets = [] }
            if !numbered.isEmpty { blocks.append(.numbered(numbered)); numbered = [] }
            if !tableRows.isEmpty {
                // Row two is the |---|---| separator; anything else is data.
                let header = tableRows[0]
                let body = tableRows.dropFirst().filter { row in !row.allSatisfy { $0.allSatisfy { "-:| ".contains($0) } } }
                blocks.append(.table(header: header, rows: Array(body)))
                tableRows = []
            }
        }

        func cells(_ line: String) -> [String] {
            var inner = Substring(line)
            if inner.hasPrefix("|") { inner = inner.dropFirst() }
            if inner.hasSuffix("|") { inner = inner.dropLast() }
            return inner.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        }

        for rawLine in text.components(separatedBy: "\n") {
            if let open = code {
                if rawLine.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    blocks.append(.code(codeLang, open.joined(separator: "\n")))
                    code = nil
                } else {
                    code = open + [rawLine]
                }
                continue
            }
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                flush()
                code = []
                codeLang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                continue
            }
            if line.isEmpty { flush(); continue }
            if line.hasPrefix("|"), line.count > 1 {
                if !paragraph.isEmpty || !bullets.isEmpty || !numbered.isEmpty { flush() }
                tableRows.append(cells(line))
                continue
            } else if !tableRows.isEmpty {
                flush()
            }
            if line == "---" || line == "***" { flush(); blocks.append(.rule); continue }
            if let level = headingLevel(line) {
                flush()
                blocks.append(.heading(level, String(line.drop(while: { $0 == "#" })).trimmingCharacters(in: .whitespaces)))
                continue
            }
            if line.hasPrefix("> ") { flush(); blocks.append(.quote(String(line.dropFirst(2)))); continue }
            if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") {
                if !paragraph.isEmpty || !numbered.isEmpty { flush() }
                bullets.append(String(line.dropFirst(2)))
                continue
            }
            if let range = line.range(of: #"^\d+[.)]\s+"#, options: .regularExpression) {
                if !paragraph.isEmpty || !bullets.isEmpty { flush() }
                numbered.append(String(line[range.upperBound...]))
                continue
            }
            if !bullets.isEmpty, rawLine.hasPrefix("  ") { bullets[bullets.count - 1] += " " + line; continue }
            if !numbered.isEmpty, rawLine.hasPrefix("  ") { numbered[numbered.count - 1] += " " + line; continue }
            if !bullets.isEmpty || !numbered.isEmpty { flush() }
            paragraph.append(line)
        }
        if let open = code { blocks.append(.code(codeLang, open.joined(separator: "\n"))) }
        flush()
        return blocks
    }

    private static func headingLevel(_ line: String) -> Int? {
        let hashes = line.prefix { $0 == "#" }.count
        guard hashes >= 1, hashes <= 4, line.dropFirst(hashes).first == " " else { return nil }
        return hashes
    }
}

struct ConnectionBadge: View {
    var state: ConnectionState?
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).font(.caption).foregroundStyle(Theme.secondary)
        }
    }
    private var color: Color {
        switch state {
        case .connected: Theme.green
        case .connecting: Theme.amber
        default: Theme.tertiary
        }
    }
    private var label: String {
        switch state {
        case .connected(let info): info.relayConnected ? "online · relay" : "online"
        case .connecting: "connecting"
        case .disconnected(let reason): reason ?? "offline"
        case nil: "offline"
        }
    }
}

/// Cards and chips shrink a touch and dim while pressed, so the UI feels solid.
struct Pressable: ButtonStyle {
    var scale: CGFloat = 0.97
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// Claude Code's spinner line: a verb, elapsed time and output tokens.
struct ActivityBar: View {
    var progress: SessionProgress
    @State private var verbIndex = 0
    @State private var now = Date.now

    private static let verbs = ["Pondering", "Brewing", "Cogitating", "Mulling", "Noodling", "Percolating", "Scheming", "Simmering", "Musing", "Working"]

    private var label: String {
        switch progress.activity {
        case .tool: "Running \(progress.detail ?? "a tool")"
        case .writing: "Writing"
        case .reading: "Reading results"
        case .waiting: "Waiting for you"
        case .thinking, .none: Self.verbs[verbIndex % Self.verbs.count]
        }
    }

    private var elapsed: String {
        let seconds = max(0, Int(now.timeIntervalSince(progress.startedAt)))
        return seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
    }

    private var tokens: String {
        let n = progress.outputTokens
        return n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "asterisk")
                .font(.caption.weight(.bold))
                .foregroundStyle(progress.activity == .waiting ? Theme.amber : Theme.coral)
                .symbolEffect(.pulse, options: .repeating, isActive: progress.activity != .waiting)
            Text(label + "…").font(.footnote.weight(.medium))
                .contentTransition(.numericText())
            Text("\(elapsed) · ↑ \(tokens) tokens").font(.caption.monospacedDigit()).foregroundStyle(Theme.tertiary)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .task(id: progress.startedAt) {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                now = .now
                if Int(now.timeIntervalSince(progress.startedAt)) % 4 == 0 { withAnimation { verbIndex += 1 } }
            }
        }
    }
}
