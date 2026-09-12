import SwiftUI

/// The status line, on the phone: account windows, model, context, cost.
/// Collapsed it is two dense rows; tapping expands the other accounts.
struct SessionHUD: View {
    var session: Session
    var accounts: [Account]
    var toolCalls: Int
    @State private var expanded = false

    private var account: Account? { accounts.first { $0.name == session.profile } }
    private var fiveHour: LimitWindow? { session.limits?.fiveHour ?? account?.fiveHour }
    private var sevenDay: LimitWindow? { session.limits?.sevenDay ?? account?.sevenDay }
    private var others: [Account] { accounts.filter { $0.name != session.profile } }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            row {
                HStack(spacing: 5) {
                    Circle().fill(Theme.coral).frame(width: 7, height: 7)
                    Text(session.profile ?? "—").font(.caption.weight(.semibold))
                    if let plan = account?.plan { Text(plan.lowercased().replacingOccurrences(of: "claude ", with: "")).font(.caption2).foregroundStyle(Theme.tertiary) }
                }
                window("5h", fiveHour)
                window("7d", sevenDay)
                Image(systemName: "chevron.down").font(.caption2).foregroundStyle(Theme.tertiary).rotationEffect(.degrees(expanded ? 180 : 0))
            }
            row {
                Text(session.model?.modelDisplayName ?? "Default").font(.caption.weight(.medium)).foregroundStyle(Color(red: 0.55, green: 0.8, blue: 0.85))
                if let effort = session.effort { Text("·\(effort.rawValue)").font(.caption).foregroundStyle(Theme.tertiary) }
                if let pct = session.contextPercent {
                    HStack(spacing: 4) {
                        Text("ctx").font(.caption).foregroundStyle(Theme.tertiary)
                        MiniBar(fraction: pct / 100, color: pct >= 80 ? Theme.red : pct >= 60 ? Theme.amber : Color(red: 0.72, green: 0.78, blue: 0.4))
                        Text(contextLabel(pct)).font(.caption.monospacedDigit())
                    }
                }
                if let branch = session.gitBranch { Label(branch, systemImage: "arrow.triangle.branch").font(.caption).foregroundStyle(Theme.violet).lineLimit(1) }
                if let cost = session.totalCostUsd { Text(cost, format: .currency(code: "USD").precision(.fractionLength(2))).font(.caption.monospacedDigit()).foregroundStyle(Theme.amber) }
                if toolCalls > 0 { Label("\(toolCalls)", systemImage: "wrench").font(.caption.monospacedDigit()).foregroundStyle(Theme.tertiary) }
                Text(uptime).font(.caption.monospacedDigit()).foregroundStyle(Theme.tertiary)
            }
            if expanded {
                Divider().overlay(Theme.stroke).padding(.vertical, 2)
                if let opus = session.limits?.sevenDayOpus ?? account?.sevenDayOpus, opus.utilization != nil {
                    HStack { Text("7d Opus").font(.caption).foregroundStyle(Theme.tertiary); window("", opus) }
                }
                ForEach(others) { other in
                    HStack(spacing: 8) {
                        Circle().strokeBorder(Theme.tertiary, lineWidth: 1).frame(width: 7, height: 7)
                        Text(other.name).font(.caption)
                        window("5h", other.fiveHour)
                        window("7d", other.sevenDay)
                        Spacer()
                    }
                }
                if let ctxTokens = session.contextTokens, let max = session.contextMaxTokens {
                    Text("context \(ctxTokens.formatted()) / \(max.formatted()) tokens").font(.caption2).foregroundStyle(Theme.tertiary)
                }
                if let turns = session.numTurns, let ms = session.totalDurationMs {
                    Text("\(turns) turns · \(Duration.milliseconds(Int(ms)).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow))) of API time").font(.caption2).foregroundStyle(Theme.tertiary)
                }
                Text("Windows come from Claude Code's own rate-limit reports for this session; the status line on the Mac shows the same numbers.").font(.caption2).foregroundStyle(Theme.tertiary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.card)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.stroke).frame(height: 1) }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.snappy) { expanded.toggle() } }
    }

    /// One dense line that scrolls sideways instead of wrapping on a phone.
    private func row(@ViewBuilder content: () -> some View) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) { content() }
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
        }
        .scrollClipDisabled()
    }

    @ViewBuilder
    private func window(_ label: String, _ w: LimitWindow?) -> some View {
        HStack(spacing: 4) {
            if !label.isEmpty { Text(label).font(.caption).foregroundStyle(Theme.tertiary) }
            MiniBar(fraction: w?.utilization ?? 0, color: Theme.limitColor(w?.utilization))
            if let u = w?.utilization { Text("\(Int(u * 100))%").font(.caption.monospacedDigit()).foregroundStyle(Theme.limitColor(u)) }
            if let reset = w?.resetsAt { Text("↻\(reset.untilShort)").font(.caption2).foregroundStyle(Theme.tertiary) }
        }
    }

    private func contextLabel(_ pct: Double) -> String {
        if let max = session.contextMaxTokens { return "\(Int(pct))%/\(max >= 900_000 ? "1M" : "\(max / 1000)k")" }
        return "\(Int(pct))%"
    }

    private var uptime: String {
        let seconds = Int(Date.now.timeIntervalSince(session.createdAt))
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3600)h\(String(format: "%02d", (seconds % 3600) / 60))m" }
        return "\(seconds / 86_400)d\(seconds % 86_400 / 3600)h"
    }
}

struct MiniBar: View {
    var fraction: Double
    var color: Color
    var body: some View {
        ZStack(alignment: .leading) {
            Capsule().fill(Color.white.opacity(0.1))
            Capsule().fill(color).frame(width: 44 * min(1, max(0, fraction)))
        }
        .frame(width: 44, height: 6)
    }
}
