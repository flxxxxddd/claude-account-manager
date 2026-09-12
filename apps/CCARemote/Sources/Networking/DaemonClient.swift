// One connection to one daemon: correlates requests with responses, fans
// events out to the store, and reconnects with backoff when the socket drops.

import Foundation
import os

enum ConnectionState: Equatable, Sendable {
    case disconnected(reason: String?)
    case connecting
    case connected(DaemonInfo)

    var isConnected: Bool { if case .connected = self { true } else { false } }
    var info: DaemonInfo? { if case .connected(let info) = self { info } else { nil } }
}

enum DaemonEvent: Sendable {
    case state(ConnectionState)
    case sessionUpdated(Session)
    case sessionRemoved(String)
    case item(ChatItem)
    case delta(sessionId: String, itemId: String, text: String)
    case accounts([Account])
    case progress(SessionProgress)
    case daemonInfo(DaemonInfo)
    case relayStatus(String)
}

actor DaemonClient {
    private let transport: any Transport
    private let clientToken: String
    private let clientName: String
    private let clientId: String
    private let logger = Logger(subsystem: "app.cca.remote", category: "client")

    private var outbound: AsyncStream<DaemonEvent>.Continuation?
    private var pending: [String: CheckedContinuation<Data, any Error>] = [:]
    private var counter = 0
    private var runLoop: Task<Void, Never>?
    private(set) var state: ConnectionState = .disconnected(reason: nil)
    private var wantsConnection = false
    private var hasConnectedOnce = false

    init(transport: any Transport, clientToken: String, clientName: String, clientId: String) {
        self.transport = transport
        self.clientToken = clientToken
        self.clientName = clientName
        self.clientId = clientId
    }

    /// Starts connecting and yields every event until `stop()`.
    func events() -> AsyncStream<DaemonEvent> {
        AsyncStream { continuation in
            self.outbound = continuation
            self.wantsConnection = true
            self.runLoop = Task { await self.loop() }
            continuation.onTermination = { _ in Task { await self.stop() } }
        }
    }

    func stop() async {
        wantsConnection = false
        runLoop?.cancel()
        runLoop = nil
        await transport.disconnect()
        failAllPending(TransportError.closed("disconnected"))
        setState(.disconnected(reason: nil))
        outbound?.finish()
        outbound = nil
    }

    private func setState(_ next: ConnectionState) {
        state = next
        outbound?.yield(.state(next))
    }

    private func loop() async {
        var attempt = 0
        while wantsConnection, !Task.isCancelled {
            setState(.connecting)
            do {
                let stream = try await transport.connect()
                let readTask = Task { await self.read(stream) }
                let info = try await hello()
                attempt = 0
                hasConnectedOnce = true
                setState(.connected(info))
                await readTask.value
                if wantsConnection { setState(.disconnected(reason: "connection closed")) }
            } catch {
                logger.error("connect failed: \(error.localizedDescription)")
                setState(.disconnected(reason: error.localizedDescription))
                failAllPending(error)
                await transport.disconnect()
                // A rejected pairing token will not fix itself; stop hammering.
                if let body = error as? ResponseEnvelope.ErrorBody, body.code == "unauthorized" {
                    wantsConnection = false
                    break
                }
            }
            guard wantsConnection else { break }
            let delay = [1.0, 2.0, 4.0, 8.0, 15.0][min(attempt, 4)]
            attempt += 1
            try? await Task.sleep(for: .seconds(delay))
        }
    }

    private func read(_ stream: AsyncThrowingStream<Data, any Error>) async {
        do {
            for try await data in stream {
                dispatch(data)
            }
        } catch {
            logger.notice("socket ended: \(error.localizedDescription)")
        }
        failAllPending(TransportError.closed("connection closed"))
    }

    private func failAllPending(_ error: any Error) {
        for (_, continuation) in pending { continuation.resume(throwing: error) }
        pending.removeAll()
    }

    private func dispatch(_ data: Data) {
        switch IncomingFrame.parse(data) {
        case .response(let id, let ok, let error, let raw):
            guard let continuation = pending.removeValue(forKey: id) else { return }
            if ok { continuation.resume(returning: raw) } else { continuation.resume(throwing: error ?? ResponseEnvelope.ErrorBody(code: "internal", message: "unknown error")) }
        case .event(let name, let raw):
            handleEvent(name, raw)
        case .unknown:
            break
        }
    }

    private func handleEvent(_ name: String, _ raw: Data) {
        let decoder = JSONCoding.decoder
        do {
            switch name {
            case "session.updated": outbound?.yield(.sessionUpdated(try decoder.decode(Payload<SessionUpdatedEvent>.self, from: raw).value.session))
            case "session.removed": outbound?.yield(.sessionRemoved(try decoder.decode(Payload<SessionRemovedEvent>.self, from: raw).value.sessionId))
            case "session.item": outbound?.yield(.item(try decoder.decode(Payload<SessionItemEvent>.self, from: raw).value.item))
            case "session.delta":
                let d = try decoder.decode(Payload<SessionDeltaEvent>.self, from: raw).value
                outbound?.yield(.delta(sessionId: d.sessionId, itemId: d.itemId, text: d.text))
            case "accounts.updated": outbound?.yield(.accounts(try decoder.decode(Payload<AccountsUpdatedEvent>.self, from: raw).value.accounts))
            case "session.progress": outbound?.yield(.progress(try decoder.decode(Payload<SessionProgress>.self, from: raw).value))
            case "daemon.updated": outbound?.yield(.daemonInfo(try decoder.decode(Payload<DaemonInfo>.self, from: raw).value))
            case "relay.status":
                struct Msg: Decodable { var message: String }
                outbound?.yield(.relayStatus(try decoder.decode(Payload<Msg>.self, from: raw).value.message))
            default: break
            }
        } catch {
            logger.error("bad event \(name): \(error.localizedDescription)")
        }
    }

    // MARK: Requests

    private func hello() async throws -> DaemonInfo {
        struct Params: Encodable { var `protocol`: Int; var token: String; var clientName: String; var clientId: String }
        return try await call("hello", Params(protocol: protocolVersion, token: clientToken, clientName: clientName, clientId: clientId))
    }

    func call<R: Decodable>(_ method: String, _ params: (some Encodable)? = Optional<Empty>.none) async throws -> R {
        counter += 1
        let id = "c\(counter)"
        let frame = try JSONCoding.encoder.encode(RequestFrame(id: id, method: method, params: params))
        let raw: Data = try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task {
                do { try await transport.send(frame) } catch {
                    if let c = pending.removeValue(forKey: id) { c.resume(throwing: error) }
                }
            }
        }
        return try JSONCoding.decoder.decode(Payload<R>.self, from: raw).value
    }

    // Typed conveniences. Parameter structs stay private; the store calls these.

    struct SessionsList: Decodable { var sessions: [Session] }
    struct AccountsList: Decodable { var accounts: [Account] }
    struct ModelsList: Decodable { var models: [ModelChoice] }
    struct ProjectsList: Decodable { var projects: [Project] }
    struct HistoryList: Decodable { var entries: [HistoryEntry] }
    struct SessionBox: Decodable { var session: Session }
    struct ItemsPage: Decodable { var items: [ChatItem]; var hasMore: Bool }

    func listSessions() async throws -> [Session] { try await (call("sessions.list") as SessionsList).sessions }
    func listAccounts(fresh: Bool = false) async throws -> [Account] {
        struct P: Encodable { var fresh: Bool }
        return try await (call("accounts.list", P(fresh: fresh)) as AccountsList).accounts
    }
    func useAccount(_ name: String) async throws -> [Account] {
        struct P: Encodable { var name: String }
        return try await (call("accounts.use", P(name: name)) as AccountsList).accounts
    }
    func listModels() async throws -> [ModelChoice] { try await (call("models.list") as ModelsList).models }
    func listProjects() async throws -> [Project] { try await (call("projects.list") as ProjectsList).projects }
    func listDirectory(_ path: String) async throws -> DirectoryListing {
        struct P: Encodable { var path: String }
        return try await call("fs.list", P(path: path))
    }
    func history(cwd: String?, limit: Int = 50) async throws -> [HistoryEntry] {
        struct P: Encodable { var cwd: String?; var limit: Int }
        return try await (call("sessions.history", P(cwd: cwd, limit: limit)) as HistoryList).entries
    }

    struct CreateSession: Encodable {
        var cwd: String
        var profile: String?
        var model: String?
        var effort: EffortLevel?
        var permissionMode: PermissionMode?
        var name: String?
        var prompt: String?
        var resumeClaudeSessionId: String?
    }
    func createSession(_ params: CreateSession) async throws -> Session { try await (call("sessions.create", params) as SessionBox).session }

    func items(sessionId: String, limit: Int = 300, before: String? = nil) async throws -> ItemsPage {
        struct P: Encodable { var sessionId: String; var limit: Int; var before: String? }
        return try await call("sessions.items", P(sessionId: sessionId, limit: limit, before: before))
    }
    func send(sessionId: String, text: String) async throws -> Session {
        struct P: Encodable { var sessionId: String; var text: String }
        return try await (call("sessions.send", P(sessionId: sessionId, text: text)) as SessionBox).session
    }
    func interrupt(sessionId: String) async throws -> Session { try await (call("sessions.interrupt", IdParams(sessionId: sessionId)) as SessionBox).session }
    func stop(sessionId: String) async throws -> Session { try await (call("sessions.stop", IdParams(sessionId: sessionId)) as SessionBox).session }
    func delete(sessionId: String) async throws {
        struct R: Decodable { var deleted: Bool }
        _ = try await call("sessions.delete", IdParams(sessionId: sessionId)) as R
    }
    func rename(sessionId: String, name: String) async throws -> Session {
        struct P: Encodable { var sessionId: String; var name: String }
        return try await (call("sessions.rename", P(sessionId: sessionId, name: name)) as SessionBox).session
    }
    func setModel(sessionId: String, model: String) async throws -> Session {
        struct P: Encodable { var sessionId: String; var model: String }
        return try await (call("sessions.setModel", P(sessionId: sessionId, model: model)) as SessionBox).session
    }
    func setEffort(sessionId: String, effort: EffortLevel) async throws -> Session {
        struct P: Encodable { var sessionId: String; var effort: EffortLevel }
        return try await (call("sessions.setEffort", P(sessionId: sessionId, effort: effort)) as SessionBox).session
    }
    func setPermissionMode(sessionId: String, mode: PermissionMode) async throws -> Session {
        struct P: Encodable { var sessionId: String; var mode: PermissionMode }
        return try await (call("sessions.setPermissionMode", P(sessionId: sessionId, mode: mode)) as SessionBox).session
    }
    func respondPermission(sessionId: String, requestId: String, allow: Bool, always: Bool, message: String? = nil) async throws -> Session {
        struct P: Encodable { var sessionId: String; var requestId: String; var behavior: String; var always: Bool; var message: String? }
        return try await (call("sessions.respondPermission", P(sessionId: sessionId, requestId: requestId, behavior: allow ? "allow" : "deny", always: always, message: message)) as SessionBox).session
    }
    func respondQuestion(sessionId: String, requestId: String, answers: [String: String]) async throws -> Session {
        struct P: Encodable { var sessionId: String; var requestId: String; var answers: [String: String] }
        return try await (call("sessions.respondQuestion", P(sessionId: sessionId, requestId: requestId, answers: answers)) as SessionBox).session
    }
    func contextUsage(sessionId: String) async throws -> ContextUsage { try await call("sessions.context", IdParams(sessionId: sessionId)) }

    private struct IdParams: Encodable { var sessionId: String }
}
