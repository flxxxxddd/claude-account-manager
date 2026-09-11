import SwiftUI

/// The conversation: streamed items, tool cards, the pending prompt, composer.
struct SessionView: View {
    @Environment(AppStore.self) private var store
    var deviceId: String
    var sessionId: String

    @State private var draft = ""
    @State private var showModelSheet = false
    @State private var showThinking = false
    @FocusState private var composerFocused: Bool

    private var session: Session? { store.session(sessionId) }
    private var items: [ChatItem] { store.items[sessionId] ?? [] }
    private var client: DaemonClient? { store.client(for: deviceId) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if items.isEmpty, session?.isManaged == true {
                            cleanSlate
                        }
                        ForEach(visibleItems) { item in
                            itemView(item).id(item.id)
                        }
                        if let pending = session?.pending {
                            PendingCard(request: pending) { allow, always in
                                Task { _ = await store.perform { try await client?.respondPermission(sessionId: sessionId, requestId: pending.requestId, allow: allow, always: always) } }
                            } onAnswers: { answers in
                                Task { _ = await store.perform { try await client?.respondQuestion(sessionId: sessionId, requestId: pending.requestId, answers: answers) } }
                            }
                            .id("pending")
                        }
                        if let error = session?.error, session?.state == .error {
                            Label(error, systemImage: "exclamationmark.octagon").font(.footnote).foregroundStyle(Theme.red).card()
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: items.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                .onChange(of: session?.pending?.requestId) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                .task(id: sessionId) {
                    await store.loadItems(device: deviceId, session: sessionId)
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            if session?.isManaged == true { composer } else { externalFooter }
        }
        .background(Theme.background)
        .navigationTitle(session?.name ?? "Session")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Toggle("Show thinking", isOn: $showThinking)
                    if let session, session.isManaged {
                        Picker("Permissions", selection: Binding(get: { session.permissionMode }, set: { mode in
                            Task { _ = await store.perform { try await client?.setPermissionMode(sessionId: sessionId, mode: mode) } }
                        })) {
                            ForEach(PermissionMode.allCases) { Text($0.title).tag($0) }
                        }
                        Divider()
                        Button("Stop process", systemImage: "stop.circle") { Task { _ = await store.perform { try await client?.stop(sessionId: sessionId) } } }
                        Button("Delete session", systemImage: "trash", role: .destructive) {
                            Task { _ = await store.perform { try await client?.delete(sessionId: sessionId) } }
                        }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .sheet(isPresented: $showModelSheet) {
            if let session {
                ModelSheet(models: store.models[deviceId] ?? [], model: session.model, effort: session.effort) { model, effort in
                    Task {
                        if let model, model != session.model { _ = await store.perform { try await client?.setModel(sessionId: sessionId, model: model) } }
                        if let effort, effort != session.effort { _ = await store.perform { try await client?.setEffort(sessionId: sessionId, effort: effort) } }
                    }
                }
            }
        }
    }

    /// Hide streaming placeholders that ended empty, and thinking unless asked.
    private var visibleItems: [ChatItem] {
        items.filter { item in
            if item.kind == .thinking { return showThinking && !(item.text ?? "").isEmpty }
            if item.kind == .toolResult { return false } // rendered inside the ToolCard
            if item.kind == .text, item.done, (item.text ?? "").isEmpty { return false }
            if item.kind == .result { return false }
            return true
        }
    }

    private func result(for toolUseId: String?) -> ChatItem? {
        guard let toolUseId else { return nil }
        return items.first { $0.kind == .toolResult && $0.toolUseId == toolUseId }
    }

    @ViewBuilder
    private func itemView(_ item: ChatItem) -> some View {
        switch item.kind {
        case .text where item.role == .user:
            HStack {
                Spacer(minLength: 40)
                Text(item.text ?? "").textSelection(.enabled)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Theme.cardRaised, in: .rect(cornerRadius: 18))
            }
        case .text:
            HStack(alignment: .top, spacing: 0) {
                MessageText(text: item.text ?? "")
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !item.done { Text("▍").foregroundStyle(Theme.coral).opacity(0.8) }
            }
            .padding(.leading, item.parentToolUseId == nil ? 0 : 16)
        case .thinking:
            Text(item.text ?? "").font(.footnote).italic().foregroundStyle(Theme.tertiary).lineLimit(8)
        case .toolUse:
            ToolCard(item: item, result: result(for: item.toolUseId))
                .padding(.leading, item.parentToolUseId == nil ? 0 : 16)
        case .status:
            Label(item.text ?? "", systemImage: "arrow.triangle.2.circlepath").font(.caption).foregroundStyle(Theme.tertiary)
        case .error:
            Label(item.text ?? "", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Theme.red)
        case .result, .toolResult:
            EmptyView()
        }
    }

    private var cleanSlate: some View {
        VStack(spacing: 10) {
            Image(systemName: "pawprint.fill").font(.system(size: 40)).foregroundStyle(Theme.coral)
            Text("Clean slate").font(.title2).fontDesign(.serif)
        }
        .frame(maxWidth: .infinity).padding(.top, 120)
    }

    private var composer: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                if let session {
                    Chip(systemImage: "folder", text: session.projectName)
                    if let branch = session.gitBranch { Chip(systemImage: "arrow.triangle.branch", text: branch) }
                    if let profile = session.profile { Chip(systemImage: "person", text: profile) }
                    if let pct = session.contextPercent { Chip(systemImage: "circle.dashed", text: "\(Int(pct))% ctx") }
                }
                Spacer()
            }
            .padding(.horizontal, 14)
            VStack(spacing: 8) {
                TextField("Describe a task or ask a question…", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .focused($composerFocused)
                    .onSubmit(send)
                HStack(spacing: 10) {
                    Button { showModelSheet = true } label: {
                        Chip(text: [session?.model?.modelDisplayName ?? "Default", session?.effort?.title].compactMap { $0 }.joined(separator: " · "), tint: .primary)
                    }
                    .buttonStyle(.plain)
                    Menu {
                        ForEach(PermissionMode.allCases) { mode in
                            Button(mode.title) { Task { _ = await store.perform { try await client?.setPermissionMode(sessionId: sessionId, mode: mode) } } }
                        }
                    } label: {
                        Chip(systemImage: "shield", text: session?.permissionMode.title ?? "", tint: session?.permissionMode == .bypassPermissions ? Theme.amber : Theme.secondary)
                    }
                    .buttonStyle(.plain)
                    Spacer()
                    if session?.state == .running || session?.state == .starting {
                        Button { Task { _ = await store.perform { try await client?.interrupt(sessionId: sessionId) } } } label: {
                            Image(systemName: "stop.fill").font(.callout).frame(width: 34, height: 34)
                                .background(Theme.cardRaised, in: Circle())
                        }
                        .buttonStyle(.plain)
                    }
                    Button(action: send) {
                        Image(systemName: "arrow.up").font(.callout.weight(.bold)).foregroundStyle(.black)
                            .frame(width: 34, height: 34)
                            .background(draft.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.tertiary : Theme.coral, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                    .keyboardShortcut(.return, modifiers: .command)
                }
            }
            .padding(12)
            .background(Theme.card, in: .rect(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(Theme.stroke))
            .padding(.horizontal, 12)
            .padding(.bottom, 10)
        }
        .padding(.top, 6)
        .background(Theme.background)
    }

    private var externalFooter: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(session?.external?.kind == .background ? "Background session on the Mac" : "Terminal session on the Mac", systemImage: "terminal")
                .font(.footnote.weight(.medium))
            Text("Read-only here. It runs in \(session?.cwd ?? "") as \(session?.external?.status ?? "unknown"). Start a session from the app to steer it from the phone.")
                .font(.caption).foregroundStyle(Theme.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.card)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        Task { await store.send(device: deviceId, session: sessionId, text: text) }
    }
}
