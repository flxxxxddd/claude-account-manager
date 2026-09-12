import SwiftUI

/// Where, as whom, with which model — then the first prompt.
struct NewSessionSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var onCreated: (String) -> Void

    @State private var deviceId: String?
    @State private var projects: [Project] = []
    @State private var history: [HistoryEntry] = []
    @State private var cwd: String = ""
    @State private var profile: String?
    @State private var model: String?
    @State private var effort: EffortLevel?
    @State private var permissionMode: PermissionMode = .default
    @State private var prompt: String = ""
    @State private var resumeId: String?
    @State private var showBrowser = false
    @State private var creating = false

    private var device: Device? { store.devices.first { $0.id == deviceId } }
    private var accounts: [Account] { deviceId.flatMap { store.accounts[$0] } ?? [] }
    private var models: [ModelChoice] { deviceId.flatMap { store.models[$0] } ?? ModelSheet.fallback }

    var body: some View {
        NavigationStack {
            Form {
                if store.devices.count > 1 {
                    Picker("Mac", selection: $deviceId) {
                        ForEach(store.devices) { Text($0.name).tag(Optional($0.id)) }
                    }
                }
                Section("Project") {
                    if !projects.isEmpty {
                        Picker("Folder", selection: $cwd) {
                            ForEach(projects) { project in
                                HStack { Text(project.name); if let b = project.gitBranch { Text("· \(b)").foregroundStyle(Theme.secondary) } }.tag(project.path)
                            }
                            if !cwd.isEmpty, !projects.contains(where: { $0.path == cwd }) { Text(URL(fileURLWithPath: cwd).lastPathComponent).tag(cwd) }
                        }
                    }
                    Button { showBrowser = true } label: { Label("Browse folders…", systemImage: "folder") }
                    if !cwd.isEmpty { Text(cwd).font(.caption.monospaced()).foregroundStyle(Theme.tertiary).lineLimit(2) }
                    if !history.isEmpty {
                        Picker("Continue", selection: $resumeId) {
                            Text("New conversation").tag(Optional<String>.none)
                            ForEach(history.prefix(15)) { entry in
                                Text(entry.summary.isEmpty ? (entry.firstPrompt ?? entry.claudeSessionId) : entry.summary).lineLimit(1).tag(Optional(entry.claudeSessionId))
                            }
                        }
                    }
                }
                Section("Account") {
                    Picker("Run as", selection: $profile) {
                        ForEach(accounts) { account in
                            HStack {
                                Text(account.name)
                                if let u = account.bindingUtilization { Text("\(Int(u * 100))%").foregroundStyle(Theme.limitColor(u)) }
                            }.tag(Optional(account.name))
                        }
                    }
                    if let best = accounts.filter(\.loggedIn).min(by: { ($0.bindingUtilization ?? 0) < ($1.bindingUtilization ?? 0) }), best.name != profile {
                        Button("Use \(best.name) — most quota left") { profile = best.name }.font(.caption)
                    }
                }
                Section("Model") {
                    Picker("Model", selection: $model) {
                        Text("Default").tag(Optional<String>.none)
                        ForEach(models.filter { $0.value != "default" }) { Text($0.displayName).tag(Optional($0.value)) }
                    }
                    Picker("Effort", selection: $effort) {
                        Text("Default").tag(Optional<EffortLevel>.none)
                        ForEach(EffortLevel.allCases) { Text($0.title).tag(Optional($0)) }
                    }
                    Picker("Permissions", selection: $permissionMode) {
                        ForEach(PermissionMode.allCases) { Text($0.title).tag($0) }
                    }
                    if permissionMode == .bypassPermissions {
                        Text("Every tool runs without asking. Fine for a sandbox; risky on your main checkout.").font(.caption).foregroundStyle(Theme.amber)
                    }
                }
                Section("First message") {
                    TextField("Describe a task or ask a question…", text: $prompt, axis: .vertical).lineLimit(3...8)
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("New session")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { create() } label: { creating ? AnyView(ProgressView().controlSize(.small)) : AnyView(Text("Start").fontWeight(.semibold)) }
                        .disabled(cwd.isEmpty || deviceId == nil || creating)
                }
            }
            .sheet(isPresented: $showBrowser) {
                if let deviceId { FolderBrowser(deviceId: deviceId, start: cwd.isEmpty ? nil : cwd) { picked in cwd = picked; Task { await loadHistory() } } }
            }
            .task { await bootstrap() }
            .onChange(of: deviceId) { _, _ in Task { await bootstrap() } }
            .onChange(of: cwd) { _, _ in Task { await loadHistory() } }
        }
        .presentationBackground(Theme.background)
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 560)
        #endif
    }

    private func bootstrap() async {
        if deviceId == nil { deviceId = store.devices.first { store.connections[$0.id]?.isConnected == true }?.id ?? store.devices.first?.id }
        guard let deviceId, let client = store.client(for: deviceId) else { return }
        if store.accounts[deviceId] == nil { await store.refresh(device: deviceId) }
        profile = profile ?? accounts.first(where: \.active)?.name ?? accounts.first?.name
        if let list = try? await client.listProjects() {
            projects = list
            if cwd.isEmpty, let first = list.first { cwd = first.path }
        }
        await loadHistory()
    }

    private func loadHistory() async {
        guard let deviceId, let client = store.client(for: deviceId), !cwd.isEmpty else { return }
        history = (try? await client.history(cwd: cwd, limit: 20)) ?? []
        resumeId = nil
    }

    private func create() {
        guard let deviceId else { return }
        creating = true
        Task {
            let created = await store.createSession(device: deviceId, .init(
                cwd: cwd, profile: profile, model: model, effort: effort, permissionMode: permissionMode,
                name: nil, prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : prompt,
                resumeClaudeSessionId: resumeId
            ))
            creating = false
            if let created { dismiss(); onCreated(created.id) }
        }
    }
}

/// Minimal directory picker over `fs.list`.
struct FolderBrowser: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var deviceId: String
    var start: String?
    var onPick: (String) -> Void

    @State private var listing: DirectoryListing?
    @State private var loading = false

    var body: some View {
        NavigationStack {
            List {
                if let parent = listing?.parent {
                    Button { load(parent) } label: { Label("..", systemImage: "arrow.up") }
                }
                ForEach(listing?.entries ?? []) { entry in
                    Button { load(entry.path) } label: {
                        HStack {
                            Image(systemName: entry.isGit ? "arrow.triangle.branch" : "folder").foregroundStyle(entry.isGit ? Theme.violet : Theme.secondary)
                            Text(entry.name)
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.tertiary)
                        }
                    }
                }
            }
            .overlay { if loading { ProgressView() } }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle(listing.map { URL(fileURLWithPath: $0.path).lastPathComponent } ?? "Folders")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Choose") { if let path = listing?.path { onPick(path); dismiss() } }.disabled(listing == nil)
                }
            }
            .task { load(start ?? "~") }
        }
        .presentationBackground(Theme.background)
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 480)
        #endif
    }

    private func load(_ path: String) {
        loading = true
        Task {
            listing = await store.perform { try await store.client(for: deviceId)?.listDirectory(path) } ?? listing
            loading = false
        }
    }
}
