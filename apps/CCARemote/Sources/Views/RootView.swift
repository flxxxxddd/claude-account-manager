import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store
    @State private var selection: String?
    @State private var showPairing = false
    @State private var showNewSession = false
    @State private var showAccounts = false

    var body: some View {
        #if os(macOS)
        NavigationSplitView {
            SidebarView(selection: $selection, showPairing: $showPairing, showNewSession: $showNewSession, showAccounts: $showAccounts)
                .navigationSplitViewColumnWidth(min: 260, ideal: 300)
        } detail: {
            if let selection, let session = store.session(selection), let device = store.device(forSession: selection) {
                SessionView(deviceId: device, sessionId: session.id)
                    .id(session.id)
            } else {
                WelcomeView(showNewSession: $showNewSession)
            }
        }
        .background(Theme.background)
        .sheet(isPresented: $showPairing) { PairingView() }
        .sheet(isPresented: $showNewSession) { NewSessionSheet { selection = $0 } }
        .sheet(isPresented: $showAccounts) { AccountsView() }
        .alert("Something went wrong", isPresented: Binding(get: { store.lastError != nil }, set: { if !$0 { store.lastError = nil } })) {
            Button("OK") { store.lastError = nil }
        } message: { Text(store.lastError ?? "") }
        #else
        HomeView()
        .alert("Something went wrong", isPresented: Binding(get: { store.lastError != nil }, set: { if !$0 { store.lastError = nil } })) {
            Button("OK") { store.lastError = nil }
        } message: { Text(store.lastError ?? "") }
        #endif
    }
}

struct WelcomeView: View {
    @Environment(AppStore.self) private var store
    @Binding var showNewSession: Bool

    var body: some View {
        VStack(spacing: 24) {
            HStack(spacing: 10) {
                Image(systemName: "asterisk").font(.title).foregroundStyle(Theme.coral)
                Text("Welcome back").font(.largeTitle.weight(.medium))
            }
            if store.devices.isEmpty {
                EmptyState(title: "No Mac paired", subtitle: "Run `cca remote pair` on the Mac, then add it from the sidebar.", systemImage: "desktopcomputer")
            } else {
                Button { showNewSession = true } label: {
                    Label("New session", systemImage: "plus").padding(.horizontal, 6)
                }
                .buttonStyle(.borderedProminent).tint(Theme.coral).controlSize(.large)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }
}
