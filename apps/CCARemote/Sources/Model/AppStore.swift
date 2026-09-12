// The app's single source of truth. One DaemonClient per paired device; the
// store merges their events into observable state the views read directly.

import Foundation
import Observation
import os

@MainActor
@Observable
final class AppStore {
    // Persisted
    private(set) var devices: [Device] = []

    // Live, per device id
    private(set) var connections: [String: ConnectionState] = [:]
    private(set) var sessions: [String: [Session]] = [:]
    private(set) var accounts: [String: [Account]] = [:]
    private(set) var models: [String: [ModelChoice]] = [:]
    var relayNotes: [String: String] = [:]

    // Per session id
    private(set) var items: [String: [ChatItem]] = [:]
    private(set) var progress: [String: SessionProgress] = [:]
    private(set) var loadedItems: Set<String> = []

    var lastError: String?

    private var clients: [String: DaemonClient] = [:]
    private var pumps: [String: Task<Void, Never>] = [:]
    private let logger = Logger(subsystem: "app.cca.remote", category: "store")
    private let defaults = UserDefaults.standard
    private let devicesKey = "devices.v1"
    private let clientId: String

    init() {
        if let id = defaults.string(forKey: "clientId") {
            clientId = id
        } else {
            clientId = UUID().uuidString
            defaults.set(clientId, forKey: "clientId")
        }
        if let data = defaults.data(forKey: devicesKey), let saved = try? JSONDecoder().decode([Device].self, from: data) {
            devices = saved
        }
        // `xcrun simctl launch booted app.cca.remote --pair <link>` pairs a
        // simulator without a camera; harmless on a device.
        let arguments = ProcessInfo.processInfo.arguments
        let seeded = ProcessInfo.processInfo.environment["CCA_PAIR_LINK"]
            ?? arguments.firstIndex(of: "--pair").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        if let seeded {
            do { try pair(link: seeded) } catch { logger.error("seeded pairing failed: \(error.localizedDescription)") }
        }
        #if os(macOS)
        if devices.isEmpty, let (device, secrets) = LocalDaemon.discover() {
            try? SecretStore.save(secrets, for: device.id)
            devices = [device]
            persistDevices()
        }
        #endif
    }

    // MARK: Devices

    private func persistDevices() {
        if let data = try? JSONEncoder().encode(devices) { defaults.set(data, forKey: devicesKey) }
    }

    func pair(link: String) throws {
        let (device, secrets) = try PairingLink.parse(link)
        try SecretStore.save(secrets, for: device.id)
        if let index = devices.firstIndex(where: { $0.id == device.id }) {
            var merged = device
            merged.name = devices[index].name
            merged.pairedAt = devices[index].pairedAt
            devices[index] = merged
            disconnect(device.id)
        } else {
            devices.append(device)
        }
        persistDevices()
        connect(device.id)
    }

    func rename(device id: String, to name: String) {
        guard let index = devices.firstIndex(where: { $0.id == id }) else { return }
        devices[index].name = name.trimmingCharacters(in: .whitespaces).isEmpty ? devices[index].name : name
        persistDevices()
    }

    func setPreferDirect(_ prefer: Bool, device id: String) {
        guard let index = devices.firstIndex(where: { $0.id == id }) else { return }
        devices[index].preferDirect = prefer
        persistDevices()
        disconnect(id)
        connect(id)
    }

    func forget(device id: String) {
        disconnect(id)
        SecretStore.delete(for: id)
        devices.removeAll { $0.id == id }
        for session in sessions[id] ?? [] { items[session.id] = nil }
        sessions[id] = nil
        accounts[id] = nil
        connections[id] = nil
        persistDevices()
    }

    // MARK: Connections

    func connectAll() {
        for device in devices where clients[device.id] == nil { connect(device.id) }
    }

    func connect(_ id: String) {
        guard let device = devices.first(where: { $0.id == id }), let secrets = SecretStore.load(for: id), clients[id] == nil else { return }
        let transport: any Transport
        if device.preferDirect, let direct = device.directUrl {
            transport = DirectTransport(url: direct)
        } else if let relay = device.relayUrl, let key = try? E2EKey(base64url: secrets.e2eKey) {
            transport = RelayTransport(relayUrl: relay, deviceId: device.id, clientToken: secrets.clientToken, key: key)
        } else if let direct = device.directUrl {
            transport = DirectTransport(url: direct)
        } else {
            connections[id] = .disconnected(reason: "no route: re-pair with a relay or LAN address")
            return
        }
        let client = DaemonClient(transport: transport, clientToken: secrets.clientToken, clientName: Self.clientName, clientId: clientId)
        clients[id] = client
        pumps[id] = Task { [weak self] in
            for await event in await client.events() {
                guard let self else { break }
                await self.apply(event, device: id)
            }
        }
    }

    func disconnect(_ id: String) {
        pumps[id]?.cancel()
        pumps[id] = nil
        if let client = clients.removeValue(forKey: id) { Task { await client.stop() } }
        connections[id] = .disconnected(reason: nil)
    }

    func reconnect(_ id: String) {
        disconnect(id)
        connect(id)
    }

    private static var clientName: String {
        #if os(iOS)
        return "iPhone"
        #else
        return Host.current().localizedName ?? "Mac"
        #endif
    }

    private func apply(_ event: DaemonEvent, device id: String) async {
        switch event {
        case .state(let state):
            connections[id] = state
            if case .connected = state { await refresh(device: id) }
        case .sessionUpdated(let session):
            upsert(session, device: id)
        case .sessionRemoved(let sessionId):
            sessions[id]?.removeAll { $0.id == sessionId }
            items[sessionId] = nil
            progress[sessionId] = nil
        case .item(let item):
            var list = items[item.sessionId] ?? []
            if let index = list.firstIndex(where: { $0.id == item.id }) { list[index] = item } else { list.append(item) }
            items[item.sessionId] = list
        case .delta(let sessionId, let itemId, let text):
            guard var list = items[sessionId], let index = list.firstIndex(where: { $0.id == itemId }) else { return }
            list[index].text = (list[index].text ?? "") + text
            items[sessionId] = list
        case .accounts(let list):
            accounts[id] = list
        case .progress(let p):
            if p.activity == nil { progress[p.sessionId] = nil } else { progress[p.sessionId] = p }
        case .daemonInfo(let info):
            if case .connected = connections[id] { connections[id] = .connected(info) }
        case .relayStatus(let message):
            relayNotes[id] = message
        }
    }

    private func upsert(_ session: Session, device id: String) {
        var list = sessions[id] ?? []
        if let index = list.firstIndex(where: { $0.id == session.id }) { list[index] = session } else { list.append(session) }
        sessions[id] = list.sorted { $0.updatedAt > $1.updatedAt }
    }

    // MARK: Data

    func client(for device: String) -> DaemonClient? { clients[device] }

    func refresh(device id: String) async {
        guard let client = clients[id] else { return }
        do {
            let (sessionList, accountList) = try await (client.listSessions(), client.listAccounts())
            sessions[id] = sessionList.sorted { $0.updatedAt > $1.updatedAt }
            accounts[id] = accountList
            relayNotes[id] = nil
        } catch {
            report(error)
        }
        if models[id] == nil, let list = try? await client.listModels() { models[id] = list }
    }

    func refreshAccounts(device id: String, fresh: Bool) async {
        guard let client = clients[id] else { return }
        do { accounts[id] = try await client.listAccounts(fresh: fresh) } catch { report(error) }
    }

    func loadItems(device id: String, session sessionId: String) async {
        guard let client = clients[id], !loadedItems.contains(sessionId) else { return }
        do {
            let page = try await client.items(sessionId: sessionId)
            // Events may already have appended newer items while the page loaded.
            let live = items[sessionId] ?? []
            var merged = page.items
            for item in live where !merged.contains(where: { $0.id == item.id }) { merged.append(item) }
            items[sessionId] = merged
            loadedItems.insert(sessionId)
        } catch {
            report(error)
        }
    }

    func device(forSession sessionId: String) -> String? {
        sessions.first { $0.value.contains { $0.id == sessionId } }?.key
    }

    func session(_ sessionId: String) -> Session? {
        for list in sessions.values { if let s = list.first(where: { $0.id == sessionId }) { return s } }
        return nil
    }

    var allSessions: [(device: Device, session: Session)] {
        devices.flatMap { device in (sessions[device.id] ?? []).map { (device, $0) } }
            .sorted { $0.session.updatedAt > $1.session.updatedAt }
    }

    // MARK: Actions

    @discardableResult
    func perform<T>(_ work: () async throws -> T) async -> T? {
        do { return try await work() } catch { report(error); return nil }
    }

    func report(_ error: any Error) {
        logger.error("\(error.localizedDescription)")
        lastError = error.localizedDescription
    }

    func send(device id: String, session sessionId: String, text: String) async {
        guard let client = clients[id] else { return }
        if let updated = await perform({ try await client.send(sessionId: sessionId, text: text) }) { upsert(updated, device: id) }
    }

    func createSession(device id: String, _ params: DaemonClient.CreateSession) async -> Session? {
        guard let client = clients[id] else { return nil }
        let created = await perform { try await client.createSession(params) }
        if let created { upsert(created, device: id); loadedItems.insert(created.id) }
        return created
    }
}
