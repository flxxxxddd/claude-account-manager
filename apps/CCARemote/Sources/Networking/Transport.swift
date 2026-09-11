// Transports move frames; DaemonClient gives them meaning.
//
// Direct: ws://host:port/ws, plaintext frames, the pairing token in `hello`.
// Relay:  wss://worker/v1/client/<deviceId>?token=…, every frame sealed in an
//         Envelope and wrapped as {"e": …}; {"sys": …} carries relay status.

import Foundation

enum TransportError: Error, LocalizedError {
    case closed(String)
    case relay(String)
    var errorDescription: String? {
        switch self {
        case .closed(let why): why
        case .relay(let why): "relay: \(why)"
        }
    }
}

protocol Transport: Sendable {
    /// Connects and returns a stream of decoded frames; the stream ends when the socket closes.
    func connect() async throws -> AsyncThrowingStream<Data, any Error>
    func send(_ frame: Data) async throws
    func disconnect() async
}

/// URLSession-backed WebSocket used by both transports.
actor WebSocketConnection {
    private var task: URLSessionWebSocketTask?
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config)
    }

    func open(_ url: URL) async throws -> AsyncThrowingStream<Data, any Error> {
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 8 * 1024 * 1024
        self.task = task
        task.resume()
        // URLSessionWebSocketTask has no async "connected" signal; the first receive
        // fails fast if the handshake did. Send a ping to force the handshake.
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            task.sendPing { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        return AsyncThrowingStream { continuation in
            let receiveLoop = Task {
                do {
                    while !Task.isCancelled {
                        let message = try await task.receive()
                        switch message {
                        case .data(let data): continuation.yield(data)
                        case .string(let text): continuation.yield(Data(text.utf8))
                        @unknown default: break
                        }
                    }
                    continuation.finish()
                } catch {
                    let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) }
                    if task.closeCode != .invalid, let reason, !reason.isEmpty {
                        continuation.finish(throwing: TransportError.closed(reason))
                    } else {
                        continuation.finish(throwing: error)
                    }
                }
            }
            continuation.onTermination = { _ in receiveLoop.cancel() }
        }
    }

    func send(_ data: Data) async throws {
        guard let task else { throw TransportError.closed("not connected") }
        try await task.send(.string(String(decoding: data, as: UTF8.self)))
    }

    func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }
}

final class DirectTransport: Transport {
    private let url: URL
    private let socket = WebSocketConnection()

    init(url: URL) { self.url = url }

    func connect() async throws -> AsyncThrowingStream<Data, any Error> {
        try await socket.open(url)
    }

    func send(_ frame: Data) async throws { try await socket.send(frame) }
    func disconnect() async { await socket.close() }
}

final class RelayTransport: Transport {
    private let url: URL
    private let key: E2EKey
    private let deviceId: String
    private let socket = WebSocketConnection()

    private struct Outer: Codable {
        var sys: String?
        var message: String?
        var e: Envelope?
    }

    init(relayUrl: URL, deviceId: String, clientToken: String, key: E2EKey) {
        var components = URLComponents(url: relayUrl, resolvingAgainstBaseURL: false)!
        if components.scheme == "https" { components.scheme = "wss" }
        if components.scheme == "http" { components.scheme = "ws" }
        components.path = components.path.trimmingSuffix("/") + "/v1/client/\(deviceId)"
        components.queryItems = [URLQueryItem(name: "token", value: clientToken)]
        url = components.url!
        self.key = key
        self.deviceId = deviceId
    }

    func connect() async throws -> AsyncThrowingStream<Data, any Error> {
        let inner = try await socket.open(url)
        let key = key
        let deviceId = deviceId
        return AsyncThrowingStream { continuation in
            let pump = Task {
                do {
                    for try await raw in inner {
                        guard let outer = try? JSONCoding.decoder.decode(Outer.self, from: raw) else { continue }
                        if let sys = outer.sys {
                            if sys == "error" { continuation.yield(Self.syntheticDaemonEvent(outer.message ?? "relay error")) }
                            continue
                        }
                        guard let envelope = outer.e else { continue }
                        continuation.yield(try key.open(envelope, deviceId: deviceId))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in pump.cancel() }
        }
    }

    /// The relay's own status arrives as a fake event so the client sees one stream.
    private static func syntheticDaemonEvent(_ message: String) -> Data {
        let json = ["event": "relay.status", "params": ["message": message]] as [String: Any]
        return try! JSONSerialization.data(withJSONObject: json)
    }

    func send(_ frame: Data) async throws {
        let envelope = try key.seal(frame, deviceId: deviceId)
        let outer = Outer(e: envelope)
        try await socket.send(try JSONCoding.encoder.encode(outer))
    }

    func disconnect() async { await socket.close() }
}

private extension String {
    func trimmingSuffix(_ suffix: String) -> String {
        hasSuffix(suffix) ? String(dropLast(suffix.count)) : self
    }
}
