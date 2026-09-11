import SwiftUI

/// The palette from the reference: near-black ground, soft cards, Claude's coral.
enum Theme {
    static let background = Color(red: 0.07, green: 0.07, blue: 0.07)
    static let card = Color(red: 0.12, green: 0.12, blue: 0.125)
    static let cardRaised = Color(red: 0.16, green: 0.16, blue: 0.165)
    static let stroke = Color.white.opacity(0.07)
    static let coral = Color(red: 0.85, green: 0.47, blue: 0.34)
    static let violet = Color(red: 0.58, green: 0.53, blue: 0.93)
    static let amber = Color(red: 0.93, green: 0.66, blue: 0.29)
    static let green = Color(red: 0.36, green: 0.78, blue: 0.51)
    static let red = Color(red: 0.90, green: 0.36, blue: 0.36)
    static let secondary = Color.white.opacity(0.55)
    static let tertiary = Color.white.opacity(0.32)

    static func stateColor(_ state: SessionState) -> Color {
        switch state {
        case .running, .starting: coral
        case .requiresAction: amber
        case .idle: secondary
        case .stopped: tertiary
        case .error: red
        }
    }

    static func limitColor(_ utilization: Double?) -> Color {
        guard let u = utilization else { return tertiary }
        if u >= 0.9 { return red }
        if u >= 0.7 { return amber }
        return green
    }
}

extension View {
    func card(padding: CGFloat = 14) -> some View {
        self
            .padding(padding)
            .background(Theme.card, in: .rect(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.stroke))
    }
}

extension Date {
    /// "6d", "13h", "5m", "now" — the relative stamp in the session rows.
    var shortRelative: String {
        let seconds = Int(Date.now.timeIntervalSince(self))
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3600)h" }
        return "\(seconds / 86_400)d"
    }

    var untilShort: String {
        let seconds = Int(timeIntervalSince(.now))
        if seconds <= 0 { return "now" }
        if seconds < 3600 { return "\(max(1, seconds / 60))m" }
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        if h < 24 { return m > 0 ? "\(h)h \(m)m" : "\(h)h" }
        return "\(h / 24)d \(h % 24)h"
    }
}

extension String {
    /// Display label for a model id or alias.
    var modelDisplayName: String {
        let lower = lowercased()
        if lower.contains("fable") { return "Fable 5.1" }
        if lower.contains("opus") { return lower.contains("1m") ? "Opus 5 · 1M" : "Opus 5" }
        if lower.contains("sonnet") { return "Sonnet 5" }
        if lower.contains("haiku") { return "Haiku 4.5" }
        if lower == "default" { return "Default" }
        return self
    }
}
