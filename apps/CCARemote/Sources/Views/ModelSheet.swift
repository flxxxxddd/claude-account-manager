import SwiftUI

/// "Select model" with the effort row underneath, as in the reference.
struct ModelSheet: View {
    var models: [ModelChoice]
    @State var model: String?
    @State var effort: EffortLevel?
    var onDone: (_ model: String?, _ effort: EffortLevel?) -> Void
    @Environment(\.dismiss) private var dismiss

    private var choices: [ModelChoice] {
        models.isEmpty ? ModelSheet.fallback : models
    }

    private var efforts: [EffortLevel] {
        choices.first { $0.value == model }?.efforts ?? EffortLevel.allCases
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(choices) { choice in
                        Button {
                            model = choice.value
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(choice.displayName).font(.body.weight(.medium)).foregroundStyle(.primary)
                                    if let d = choice.description { Text(d).font(.caption).foregroundStyle(Theme.secondary) }
                                }
                                Spacer()
                                if isSelected(choice) { Image(systemName: "checkmark").foregroundStyle(Theme.coral) }
                            }
                        }
                    }
                }
                if !efforts.isEmpty {
                    Section("Effort") {
                        Picker("Effort", selection: Binding(get: { effort ?? .high }, set: { effort = $0 })) {
                            ForEach(efforts) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Select model")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Apply") { onDone(model, effort); dismiss() }.fontWeight(.semibold) }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.background)
        .frame(minWidth: 380, minHeight: 420)
    }

    private func isSelected(_ choice: ModelChoice) -> Bool {
        guard let model else { return choice.value == "default" }
        return model == choice.value || model.lowercased().contains(choice.value.lowercased())
    }

    static let fallback: [ModelChoice] = [
        ModelChoice(value: "fable", displayName: "Fable 5.1", description: "For your toughest challenges", efforts: EffortLevel.allCases),
        ModelChoice(value: "opus", displayName: "Opus 5", description: "For complex tasks", efforts: EffortLevel.allCases),
        ModelChoice(value: "sonnet", displayName: "Sonnet 5", description: "Most efficient for everyday tasks", efforts: EffortLevel.allCases),
        ModelChoice(value: "haiku", displayName: "Haiku 4.5", description: "Fastest for quick answers", efforts: []),
    ]
}
