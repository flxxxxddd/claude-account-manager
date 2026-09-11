import SwiftUI

struct DeviceDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var deviceId: String
    @State private var name = ""

    private var device: Device? { store.devices.first { $0.id == deviceId } }

    var body: some View {
        Form {
            if let device {
                Section {
                    TextField("Name", text: $name).onSubmit { store.rename(device: deviceId, to: name) }
                    LabeledContent("Status") { ConnectionBadge(state: store.connections[deviceId]) }
                    if let info = store.connections[deviceId]?.info {
                        LabeledContent("Daemon", value: "cca \(info.daemonVersion)")
                        if let cc = info.claudeVersion { LabeledContent("Claude Code", value: cc) }
                        LabeledContent("Host", value: info.hostname)
                    }
                    if let note = store.relayNotes[deviceId] { Text(note).font(.caption).foregroundStyle(Theme.amber) }
                }
                Section("Route") {
                    if let relay = device.relayUrl { LabeledContent("Relay", value: relay.host() ?? relay.absoluteString) }
                    if let direct = device.directUrl { LabeledContent("Direct", value: direct.absoluteString) }
                    if device.relayUrl != nil, device.directUrl != nil {
                        Toggle("Prefer direct connection", isOn: Binding(get: { device.preferDirect }, set: { store.setPreferDirect($0, device: deviceId) }))
                    }
                    Button("Reconnect") { store.reconnect(deviceId) }
                }
                Section {
                    LabeledContent("Device id", value: device.id).font(.caption.monospaced())
                    LabeledContent("Paired", value: device.pairedAt.formatted(date: .abbreviated, time: .shortened))
                    Button("Forget this Mac", role: .destructive) { store.forget(device: deviceId); dismiss() }
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle(device?.name ?? "Device")
        .onAppear { name = device?.name ?? "" }
    }
}
