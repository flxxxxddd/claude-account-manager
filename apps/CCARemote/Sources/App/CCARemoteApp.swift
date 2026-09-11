import SwiftUI

@main
struct CCARemoteApp: App {
    @State private var store = AppStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .preferredColorScheme(.dark)
                .onOpenURL { url in
                    // ccaremote://pair#… from Camera or a pasted link.
                    do { try store.pair(link: url.absoluteString) } catch { store.report(error) }
                }
                .task { store.connectAll() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { store.connectAll() }
                }
        }
        #if os(macOS)
        .defaultSize(width: 1100, height: 720)
        .windowStyle(.hiddenTitleBar)
        #endif
    }
}
