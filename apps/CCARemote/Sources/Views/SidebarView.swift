#if os(macOS)
import SwiftUI

/// macOS sidebar: sessions grouped by Mac, like the reference's project groups.
struct SidebarView: View {
    @Environment(AppStore.self) private var store
    @Binding var selection: String?
    @Binding var showPairing: Bool
    @Binding var showNewSession: Bool
    @Binding var showAccounts: Bool

    var body: some View {
        List(selection: $selection) {
            Section {
                Button { showNewSession = true } label: { Label("New", systemImage: "plus") }
                Button { showAccounts = true } label: { Label("Accounts", systemImage: "person.2") }
                Button { showPairing = true } label: { Label("Add device", systemImage: "qrcode") }
            }
            .buttonStyle(.plain)

            ForEach(store.devices) { device in
                Section {
                    ForEach(store.sessions[device.id] ?? []) { session in
                        HStack(spacing: 8) {
                            if session.needsInput {
                                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.amber).font(.caption)
                            } else if session.isManaged {
                                Image(systemName: "arrow.triangle.branch").foregroundStyle(Theme.violet).font(.caption)
                            } else {
                                Image(systemName: "terminal").foregroundStyle(Theme.secondary).font(.caption)
                            }
                            Text(session.name).lineLimit(1)
                            Spacer()
                            if session.state == .running { StatusDot(state: .running) }
                        }
                        .tag(session.id)
                        .contextMenu {
                            if session.isManaged {
                                Button("Stop process") { Task { _ = try? await store.client(for: device.id)?.stop(sessionId: session.id) } }
                                Button("Delete", role: .destructive) { Task { try? await store.client(for: device.id)?.delete(sessionId: session.id); await store.refresh(device: device.id) } }
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text(device.name)
                        Spacer()
                        ConnectionBadge(state: store.connections[device.id])
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            if let device = store.devices.first, let active = (store.accounts[device.id] ?? []).first(where: \.active) {
                Button { showAccounts = true } label: {
                    HStack(spacing: 8) {
                        Circle().fill(Theme.coral.opacity(0.3)).frame(width: 24, height: 24)
                            .overlay(Text(String(active.name.prefix(1)).uppercased()).font(.caption.weight(.bold)))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(active.name).font(.callout)
                            Text(active.plan ?? active.email ?? "").font(.caption2).foregroundStyle(Theme.secondary)
                        }
                        Spacer()
                        if let u = active.bindingUtilization {
                            Text("\(Int(u * 100))%").font(.caption.monospacedDigit()).foregroundStyle(Theme.limitColor(u))
                        }
                    }
                    .padding(10)
                }
                .buttonStyle(.plain)
                .background(.bar)
            }
        }
    }
}
#endif
