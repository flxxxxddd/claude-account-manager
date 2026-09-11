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

/// Markdown-ish text: headings and lists render acceptably via AttributedString.
struct MessageText: View {
    var text: String
    var body: some View {
        if let attributed = try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(attributed).textSelection(.enabled)
        } else {
            Text(text).textSelection(.enabled)
        }
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
