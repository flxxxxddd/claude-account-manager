import SwiftUI

/// A collapsed line for a tool call, expandable to input and output.
struct ToolCard: View {
    var item: ChatItem
    var result: ChatItem?
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: icon).font(.caption).foregroundStyle(iconColor).frame(width: 16)
                    Text(item.toolName ?? "tool").font(.caption.weight(.semibold)).foregroundStyle(.primary)
                    Text(item.toolSummary ?? "").font(.caption.monospaced()).foregroundStyle(Theme.secondary).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    if !item.done || (result == nil && item.done) {
                        ProgressView().controlSize(.mini)
                    } else if result?.isError == true {
                        Image(systemName: "exclamationmark.triangle.fill").font(.caption2).foregroundStyle(Theme.red)
                    }
                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(Theme.tertiary).rotationEffect(.degrees(expanded ? 90 : 0))
                }
            }
            .buttonStyle(.plain)

            if expanded {
                if let input = item.toolInput {
                    codeBlock(inputText(input), label: "input")
                }
                if let output = result?.output, !output.isEmpty {
                    codeBlock(output, label: result?.isError == true ? "error" : "output")
                }
            }
        }
        .padding(10)
        .background(Theme.card, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.stroke))
    }

    private func inputText(_ input: JSONValue) -> String {
        if let command = input["command"]?.stringValue { return command }
        if let content = input["content"]?.stringValue, let path = input["file_path"]?.stringValue { return "\(path)\n\n\(content)" }
        return input.prettyPrinted
    }

    private func codeBlock(_ text: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(Theme.tertiary)
            ScrollView(.horizontal) {
                Text(text.count > 6000 ? String(text.prefix(6000)) + "\n…" : text)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 260)
        }
        .padding(8)
        .background(Color.black.opacity(0.35), in: .rect(cornerRadius: 8))
    }

    private var icon: String {
        switch item.toolName ?? "" {
        case "Bash": "terminal"
        case "Read": "doc.text"
        case "Edit", "Write", "MultiEdit", "NotebookEdit": "pencil"
        case "Glob", "Grep": "magnifyingglass"
        case "WebFetch", "WebSearch": "globe"
        case "Task", "Agent": "person.2"
        case "AskUserQuestion": "questionmark.bubble"
        case "TodoWrite": "checklist"
        default: "wrench"
        }
    }

    private var iconColor: Color {
        switch item.toolName ?? "" {
        case "Edit", "Write", "MultiEdit": Theme.coral
        case "Task", "Agent": Theme.violet
        default: Theme.secondary
        }
    }
}
