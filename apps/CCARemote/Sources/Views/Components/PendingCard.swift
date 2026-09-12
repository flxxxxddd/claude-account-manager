import SwiftUI

/// "Waiting for you": a permission prompt or an AskUserQuestion, answered inline.
struct PendingCard: View {
    var request: PendingRequest
    var onPermission: (_ allow: Bool, _ always: Bool) -> Void
    var onAnswers: ([String: String]) -> Void

    @State private var selections: [String: Set<String>] = [:]
    @State private var custom: [String: String] = [:]
    @State private var showInput = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill").foregroundStyle(Theme.amber)
                Text("Waiting for you").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.amber)
                Spacer()
            }
            switch request {
            case .permission(let p): permission(p)
            case .question(let q): questions(q)
            }
        }
        .padding(14)
        .background(Theme.amber.opacity(0.08), in: .rect(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.amber.opacity(0.35)))
    }

    @ViewBuilder
    private func permission(_ p: PendingRequest.PermissionRequest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Claude wants to run **\(p.toolName)**").font(.subheadline)
            Text(p.summary).font(.caption.monospaced()).foregroundStyle(Theme.secondary).lineLimit(showInput ? nil : 3)
            if let reason = p.decisionReason { Text(reason).font(.caption).foregroundStyle(Theme.tertiary) }
            Button(showInput ? "Hide details" : "Show details") { withAnimation { showInput.toggle() } }
                .font(.caption).buttonStyle(.plain).foregroundStyle(Theme.coral)
            if showInput {
                ScrollView(.horizontal) {
                    Text(p.input.prettyPrinted).font(.caption2.monospaced()).textSelection(.enabled)
                }.frame(maxHeight: 200)
            }
        }
        HStack(spacing: 8) {
            Button("Deny") { onPermission(false, false) }.buttonStyle(.bordered).tint(Theme.red)
            Spacer()
            if p.canAlwaysAllow {
                Button("Always") { onPermission(true, true) }.buttonStyle(.bordered).tint(Theme.secondary)
            }
            Button("Allow") { onPermission(true, false) }.buttonStyle(.borderedProminent).tint(Theme.coral)
        }
    }

    @ViewBuilder
    private func questions(_ q: PendingRequest.QuestionRequest) -> some View {
        ForEach(Array(q.questions.enumerated()), id: \.offset) { _, question in
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Text(question.header.uppercased()).font(.caption2.weight(.bold)).foregroundStyle(Theme.tertiary)
                    if question.multiSelect { Text("· pick any").font(.caption2).foregroundStyle(Theme.tertiary) }
                }
                Text(question.question).font(.subheadline)
                ForEach(question.options, id: \.label) { option in
                    let picked = selections[question.question]?.contains(option.label) ?? false
                    Button {
                        var set = selections[question.question] ?? []
                        if question.multiSelect { if picked { set.remove(option.label) } else { set.insert(option.label) } } else { set = [option.label] }
                        selections[question.question] = set
                        custom[question.question] = nil
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: picked ? "checkmark.circle.fill" : "circle").foregroundStyle(picked ? Theme.coral : Theme.tertiary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.label).font(.subheadline.weight(.medium))
                                Text(option.description).font(.caption).foregroundStyle(Theme.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(10)
                        .background(picked ? Theme.coral.opacity(0.12) : Theme.card, in: .rect(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                }
                // Claude's own app always offers a free-text answer too.
                HStack(spacing: 10) {
                    Image(systemName: (custom[question.question]?.isEmpty == false) ? "checkmark.circle.fill" : "pencil.circle")
                        .foregroundStyle((custom[question.question]?.isEmpty == false) ? Theme.coral : Theme.tertiary)
                    TextField("Other…", text: Binding(get: { custom[question.question] ?? "" }, set: { value in
                        custom[question.question] = value
                        if !value.isEmpty { selections[question.question] = [] }
                    }), axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(1...4)
                }
                .padding(10)
                .background(Theme.card, in: .rect(cornerRadius: 12))
            }
        }
        HStack {
            Spacer()
            Button("Answer") {
                var answers: [String: String] = [:]
                for question in q.questions {
                    let typed = custom[question.question]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    answers[question.question] = typed.isEmpty ? (selections[question.question] ?? []).sorted().joined(separator: ", ") : typed
                }
                onAnswers(answers)
            }
            .buttonStyle(.borderedProminent).tint(Theme.coral)
            .disabled(q.questions.contains { (selections[$0.question] ?? []).isEmpty && (custom[$0.question]?.trimmingCharacters(in: .whitespaces).isEmpty ?? true) })
        }
    }
}
