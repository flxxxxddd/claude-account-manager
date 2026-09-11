// Request/response/event framing, see protocol.ts "Framing".

import Foundation

struct RequestFrame<P: Encodable>: Encodable {
    var id: String
    var method: String
    var params: P?
}

struct ResponseEnvelope: Decodable {
    var id: String
    var ok: Bool
    var error: ErrorBody?

    struct ErrorBody: Decodable, Error, LocalizedError {
        var code: String
        var message: String
        var errorDescription: String? { message }
    }
}

struct EventEnvelope: Decodable {
    var event: String
}

enum IncomingFrame {
    case response(id: String, ok: Bool, error: ResponseEnvelope.ErrorBody?, raw: Data)
    case event(name: String, raw: Data)
    case unknown

    static func parse(_ data: Data) -> IncomingFrame {
        if let response = try? JSONCoding.decoder.decode(ResponseEnvelope.self, from: data) {
            return .response(id: response.id, ok: response.ok, error: response.error, raw: data)
        }
        if let event = try? JSONCoding.decoder.decode(EventEnvelope.self, from: data) {
            return .event(name: event.event, raw: data)
        }
        return .unknown
    }
}

/// Decodes the `result` (or `params`) sub-object of a frame without a wrapper type per method.
struct Payload<T: Decodable>: Decodable {
    var result: T?
    var params: T?
    var value: T { (result ?? params)! }
}

struct Empty: Codable {}

// Typed event payloads

struct SessionUpdatedEvent: Decodable { var session: Session }
struct SessionRemovedEvent: Decodable { var sessionId: String }
struct SessionItemEvent: Decodable { var item: ChatItem }
struct SessionDeltaEvent: Decodable { var sessionId: String; var itemId: String; var text: String }
struct AccountsUpdatedEvent: Decodable { var accounts: [Account] }
