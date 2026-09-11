import SwiftUI
#if os(iOS)
import VisionKit
#endif

/// Add a Mac: scan the QR from `cca remote pair`, or paste the link.
struct PairingView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                #if os(iOS)
                if DataScannerViewController.isSupported, DataScannerViewController.isAvailable {
                    QRScanner { code in pair(code) }
                        .frame(height: 300)
                        .clipShape(.rect(cornerRadius: 20))
                        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Theme.stroke))
                    Text("Point at the QR code from `cca remote pair`").font(.subheadline).foregroundStyle(Theme.secondary)
                }
                #else
                if let local = LocalDaemon.discover() {
                    Button {
                        try? SecretStore.save(local.1, for: local.0.id)
                        pairLocal(local.0)
                    } label: {
                        Label("Use the daemon on this Mac", systemImage: "desktopcomputer").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).tint(Theme.coral).controlSize(.large)
                    Text("Found ~/.ccacc/remote/identity.json").font(.caption).foregroundStyle(Theme.tertiary)
                }
                #endif
                VStack(alignment: .leading, spacing: 8) {
                    Text("Or paste the link").font(.subheadline.weight(.medium))
                    TextField("ccaremote://pair#…", text: $link, axis: .vertical)
                        .textFieldStyle(.roundedBorder).lineLimit(2...4)
                        #if os(iOS)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        #endif
                    Button("Pair") { pair(link) }
                        .buttonStyle(.borderedProminent).tint(Theme.coral)
                        .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if let error { Text(error).font(.footnote).foregroundStyle(Theme.red) }
                Spacer()
                VStack(alignment: .leading, spacing: 6) {
                    Text("On the Mac").font(.caption.weight(.semibold)).foregroundStyle(Theme.secondary)
                    Text("cca remote install\ncca remote pair").font(.caption.monospaced()).foregroundStyle(Theme.secondary)
                    Text("Away from home you need the relay: `cca remote config --relay wss://…` — see relay/README.md.").font(.caption2).foregroundStyle(Theme.tertiary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(20)
            .background(Theme.background)
            .navigationTitle("Add device")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationBackground(Theme.background)
        .frame(minWidth: 440, minHeight: 420)
    }

    private func pair(_ text: String) {
        do {
            try store.pair(link: text)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    #if os(macOS)
    private func pairLocal(_ device: Device) {
        // Same code path as a scanned link, minus the QR: rebuild the link so one parser rules.
        struct Payload: Encodable { var v = 1; var deviceId: String; var clientToken: String; var e2eKey: String; var relayUrl: String?; var directUrl: String?; var hostname: String }
        guard let secrets = SecretStore.load(for: device.id) else { return }
        let payload = Payload(deviceId: device.id, clientToken: secrets.clientToken, e2eKey: secrets.e2eKey, relayUrl: device.relayUrl?.absoluteString, directUrl: device.directUrl?.absoluteString, hostname: device.name)
        if let data = try? JSONEncoder().encode(payload) { pair("ccaremote://pair#\(data.base64url)") }
    }
    #endif
}

#if os(iOS)
struct QRScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var fired = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !fired else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item, let value = barcode.payloadStringValue, value.hasPrefix("ccaremote://") {
                    fired = true
                    dataScanner.stopScanning()
                    onCode(value)
                    return
                }
            }
        }
    }
}
#endif
