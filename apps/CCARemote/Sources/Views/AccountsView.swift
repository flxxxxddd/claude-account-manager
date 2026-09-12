import SwiftUI

/// cca profiles with their limit windows; tap to make one the active account.
struct AccountsView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var refreshing = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(store.devices) { device in
                    Section {
                        let accounts = store.accounts[device.id] ?? []
                        if accounts.isEmpty {
                            Text(store.connections[device.id]?.isConnected == true ? "No profiles — run `cca import` on the Mac." : "Offline").foregroundStyle(Theme.secondary)
                        }
                        ForEach(accounts) { account in
                            AccountRow(account: account) {
                                Task { await store.perform { _ = try await store.client(for: device.id)?.useAccount(account.name) } }
                            }
                        }
                    } header: {
                        if store.devices.count > 1 { Text(device.name) }
                    } footer: {
                        if let fetched = (store.accounts[device.id] ?? []).compactMap(\.usageFetchedAt).min() {
                            Text("Limits as of \(fetched.formatted(date: .omitted, time: .shortened)). The active account is what the next `cca` launch and new sessions use by default.")
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Accounts")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        refreshing = true
                        Task {
                            for device in store.devices { await store.refreshAccounts(device: device.id, fresh: true) }
                            refreshing = false
                        }
                    } label: { refreshing ? AnyView(ProgressView().controlSize(.small)) : AnyView(Image(systemName: "arrow.clockwise")) }
                    .disabled(refreshing)
                }
            }
        }
        .presentationBackground(Theme.background)
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 480)
        #endif
    }
}

struct AccountRow: View {
    var account: Account
    var makeActive: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Circle().fill(account.active ? Theme.coral : Theme.cardRaised).frame(width: 30, height: 30)
                    .overlay(Text(String(account.name.prefix(1)).uppercased()).font(.caption.weight(.bold)).foregroundStyle(account.active ? .black : .primary))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(account.name).font(.body.weight(.medium))
                        if account.active { Text("active").font(.caption2.weight(.semibold)).foregroundStyle(Theme.coral) }
                        if !account.loggedIn { Text("logged out").font(.caption2.weight(.semibold)).foregroundStyle(Theme.red) }
                    }
                    Text([account.email, account.plan].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(Theme.secondary)
                }
                Spacer()
                if !account.active {
                    Button("Use") { makeActive() }.buttonStyle(.bordered).controlSize(.small).tint(Theme.coral)
                }
            }
            LimitBar(title: "Session (5h)", window: account.fiveHour)
            LimitBar(title: "Week", window: account.sevenDay)
            if let opus = account.sevenDayOpus, opus.utilization != nil { LimitBar(title: "Week · Opus", window: opus) }
            if let expires = account.loginExpiresAt, expires.timeIntervalSinceNow < 7 * 86_400 {
                Label("Login expires in \(expires.untilShort) — run `cca login \(account.name)` on the Mac", systemImage: "key")
                    .font(.caption).foregroundStyle(Theme.amber)
            }
            if let error = account.error, account.loggedIn == false || account.fiveHour == nil {
                Text(error).font(.caption2).foregroundStyle(Theme.tertiary).lineLimit(2)
            }
        }
        .padding(.vertical, 6)
    }
}
