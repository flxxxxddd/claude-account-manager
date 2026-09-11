#if os(iOS)
import SwiftUI

/// iPhone home: paired Macs on top, every session below.
struct HomeView: View {
    @Environment(AppStore.self) private var store
    @State private var showPairing = false
    @State private var showNewSession = false
    @State private var showAccounts = false
    @State private var filter: Filter = .all
    @State private var path: [String] = []

    enum Filter: String, CaseIterable, Identifiable {
        case all = "All", needsInput = "Needs input", running = "Running"
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack(path: $path) {
            content
        }
        .tint(Theme.coral)
    }

    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14, pinnedViews: []) {
                Text("Devices").font(.title3.weight(.semibold)).padding(.top, 8)
                devicesRow
                HStack {
                    Text("Sessions").font(.title3.weight(.semibold))
                    Spacer()
                    Menu {
                        Picker("Filter", selection: $filter) { ForEach(Filter.allCases) { Text($0.rawValue).tag($0) } }
                    } label: {
                        HStack(spacing: 4) { Text(filter.rawValue); Image(systemName: "chevron.down").font(.caption2) }
                            .foregroundStyle(Theme.secondary)
                    }
                }
                .padding(.top, 10)
                sessionsList
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 90)
        }
        .background(Theme.background)
        .navigationTitle("Code")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: String.self) { sessionId in
            if let device = store.device(forSession: sessionId) {
                SessionView(deviceId: device, sessionId: sessionId)
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showAccounts = true } label: { Image(systemName: "person.crop.circle") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showPairing = true } label: { Image(systemName: "qrcode.viewfinder") }
            }
        }
        .overlay(alignment: .bottom) {
            if !store.devices.isEmpty {
                Button { showNewSession = true } label: {
                    Label("New session", systemImage: "plus").font(.headline).padding(.horizontal, 10).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.black).controlSize(.large)
                .clipShape(Capsule())
                .padding(.bottom, 18)
                .shadow(radius: 12, y: 6)
            }
        }
        .sheet(isPresented: $showPairing) { PairingView() }
        .sheet(isPresented: $showNewSession) { NewSessionSheet { path.append($0) } }
        .sheet(isPresented: $showAccounts) { AccountsView() }
        .refreshable { for device in store.devices { await store.refresh(device: device.id) } }
        .task {
            // Simulator/UI-test hook: `SIMCTL_CHILD_CCA_OPEN_SESSION=<id>` opens a session on launch.
            guard let seed = ProcessInfo.processInfo.environment["CCA_OPEN_SESSION"], path.isEmpty else { return }
            for _ in 0..<40 where store.session(seed) == nil { try? await Task.sleep(for: .milliseconds(250)) }
            if store.session(seed) != nil { path = [seed] }
        }
    }

    private var devicesRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(store.devices) { device in
                    NavigationLink { DeviceDetailView(deviceId: device.id) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "laptopcomputer").foregroundStyle(Theme.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(device.name).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                                ConnectionBadge(state: store.connections[device.id])
                            }
                        }
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(Theme.card, in: Capsule())
                        .overlay(Capsule().strokeBorder(Theme.stroke))
                    }
                    .buttonStyle(.plain)
                }
                Button { showPairing = true } label: {
                    Label("Add device", systemImage: "plus").font(.subheadline.weight(.medium))
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .background(Theme.card, in: Capsule())
                        .overlay(Capsule().strokeBorder(Theme.stroke))
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var sessionsList: some View {
        let rows = store.allSessions.filter { pair in
            switch filter {
            case .all: true
            case .needsInput: pair.session.needsInput
            case .running: pair.session.state == .running || pair.session.state == .starting
            }
        }
        if rows.isEmpty {
            EmptyState(title: store.devices.isEmpty ? "Pair your Mac" : "No sessions yet",
                       subtitle: store.devices.isEmpty ? "Run `cca remote pair` on the Mac and scan the code." : "Start one with the button below, or run `cca` on the Mac.",
                       systemImage: store.devices.isEmpty ? "qrcode" : "sparkles")
                .frame(maxWidth: .infinity).padding(.top, 40)
        } else {
            ForEach(rows, id: \.session.id) { pair in
                NavigationLink(value: pair.session.id) {
                    SessionRow(session: pair.session, deviceName: store.devices.count > 1 ? pair.device.name : nil)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct SessionRow: View {
    var session: Session
    var deviceName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if session.isManaged {
                    Image(systemName: "arrow.triangle.branch").font(.caption).foregroundStyle(Theme.violet)
                } else {
                    Image(systemName: session.external?.kind == .background ? "moon.zzz" : "terminal").font(.caption).foregroundStyle(Theme.secondary)
                }
                Text(session.name).font(.body.weight(.medium)).lineLimit(1)
                Spacer(minLength: 6)
                if session.needsInput {
                    Text("Waiting for you · \(session.updatedAt.shortRelative)").font(.caption).foregroundStyle(Theme.amber).lineLimit(1)
                } else if session.state == .running || session.state == .starting {
                    HStack(spacing: 5) { StatusDot(state: session.state); Text("Working").font(.caption).foregroundStyle(Theme.coral) }
                } else {
                    Text(session.updatedAt.shortRelative).font(.caption).foregroundStyle(Theme.tertiary)
                }
            }
            HStack(spacing: 6) {
                Image(systemName: session.isManaged ? "folder" : "display").font(.caption2)
                Text([deviceName, session.projectName].compactMap { $0 }.joined(separator: "/")).font(.caption)
                if let branch = session.gitBranch { Text("· \(branch)").font(.caption) }
                if let profile = session.profile { Text("· \(profile)").font(.caption) }
            }
            .foregroundStyle(Theme.secondary).lineLimit(1)
            if session.needsInput, let pending = session.pending {
                Text(pendingPreview(pending)).font(.footnote).foregroundStyle(.primary.opacity(0.85)).lineLimit(3)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.cardRaised, in: .rect(cornerRadius: 12))
            } else if let preview = session.preview, !preview.isEmpty, session.isManaged {
                Text(preview).font(.footnote).foregroundStyle(Theme.secondary).lineLimit(2)
            }
        }
        .card()
    }

    private func pendingPreview(_ pending: PendingRequest) -> String {
        switch pending {
        case .permission(let p): "Allow \(p.toolName)? \(p.summary)"
        case .question(let q): q.questions.first?.question ?? "Claude has a question"
        }
    }
}
#endif
