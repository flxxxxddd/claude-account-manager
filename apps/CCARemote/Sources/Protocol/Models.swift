// Mirrors src/remote/protocol.ts. Keep the two in step; PROTOCOL_VERSION guards drift.

import Foundation

let protocolVersion = 1

enum PermissionMode: String, Codable, CaseIterable, Sendable, Identifiable {
    case `default`, acceptEdits, plan, bypassPermissions, dontAsk, auto
    var id: String { rawValue }

    var title: String {
        switch self {
        case .default: "Ask before acting"
        case .acceptEdits: "Accept edits"
        case .plan: "Plan mode"
        case .bypassPermissions: "Bypass permissions"
        case .dontAsk: "Don't ask (deny)"
        case .auto: "Auto"
        }
    }
}

enum EffortLevel: String, Codable, CaseIterable, Sendable, Identifiable {
    case low, medium, high, xhigh, max
    var id: String { rawValue }
    var title: String {
        switch self {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .xhigh: "Extra high"
        case .max: "Max"
        }
    }
}

enum SessionState: String, Codable, Sendable {
    case idle, running, requiresAction = "requires_action", starting, stopped, error
}

struct LimitWindow: Codable, Hashable, Sendable {
    var utilization: Double?
    var resetsAt: Date?
}

struct Account: Codable, Identifiable, Hashable, Sendable {
    var name: String
    var email: String?
    var organization: String?
    var plan: String?
    var active: Bool
    var loggedIn: Bool
    var fiveHour: LimitWindow?
    var sevenDay: LimitWindow?
    var sevenDayOpus: LimitWindow?
    var loginExpiresAt: Date?
    var usageFetchedAt: Date?
    var error: String?

    var id: String { name }

    /// The window that will actually stop you: the highest of every reported one.
    var bindingUtilization: Double? {
        [fiveHour, sevenDay, sevenDayOpus].compactMap { $0?.utilization }.max()
    }
}

struct ModelChoice: Codable, Identifiable, Hashable, Sendable {
    var value: String
    var displayName: String
    var description: String?
    var efforts: [EffortLevel]
    var id: String { value }
}

struct QuestionOption: Codable, Hashable, Sendable {
    var label: String
    var description: String
}

struct Question: Codable, Hashable, Sendable {
    var question: String
    var header: String
    var multiSelect: Bool
    var options: [QuestionOption]
}

enum PendingRequest: Codable, Hashable, Sendable {
    case permission(PermissionRequest)
    case question(QuestionRequest)

    struct PermissionRequest: Codable, Hashable, Sendable {
        var requestId: String
        var toolName: String
        var toolUseId: String?
        var input: JSONValue
        var summary: String
        var decisionReason: String?
        var canAlwaysAllow: Bool
        var createdAt: Date
    }

    struct QuestionRequest: Codable, Hashable, Sendable {
        var requestId: String
        var toolUseId: String?
        var questions: [Question]
        var createdAt: Date
    }

    private enum CodingKeys: String, CodingKey { case kind }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "permission": self = .permission(try PermissionRequest(from: decoder))
        case "question": self = .question(try QuestionRequest(from: decoder))
        case let other: throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "unknown pending kind \(other)")
        }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .permission(let request):
            try container.encode("permission", forKey: .kind)
            try request.encode(to: encoder)
        case .question(let request):
            try container.encode("question", forKey: .kind)
            try request.encode(to: encoder)
        }
    }

    var requestId: String {
        switch self {
        case .permission(let request): request.requestId
        case .question(let request): request.requestId
        }
    }
}

struct ExternalInfo: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable { case interactive, background }
    var kind: Kind
    var pid: Int?
    var status: String?
}

struct Session: Codable, Identifiable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable { case managed, external }

    var id: String
    var name: String
    var cwd: String
    var profile: String?
    var model: String?
    var effort: EffortLevel?
    var permissionMode: PermissionMode
    var state: SessionState
    var createdAt: Date
    var updatedAt: Date
    var preview: String?
    var pending: PendingRequest?
    var kind: Kind
    var external: ExternalInfo?
    var gitBranch: String?
    var contextPercent: Double?
    var totalCostUsd: Double?
    var claudeSessionId: String?
    var error: String?

    var projectName: String { URL(fileURLWithPath: cwd).lastPathComponent }
    var isManaged: Bool { kind == .managed }
    var needsInput: Bool { state == .requiresAction }
}

struct HistoryEntry: Codable, Identifiable, Hashable, Sendable {
    var claudeSessionId: String
    var cwd: String
    var summary: String
    var firstPrompt: String?
    var gitBranch: String?
    var lastModified: Date
    var createdAt: Date?
    var id: String { claudeSessionId }
}

struct Project: Codable, Identifiable, Hashable, Sendable {
    var path: String
    var name: String
    var lastUsedAt: Date?
    var gitBranch: String?
    var id: String { path }
}

struct DirectoryListing: Codable, Sendable {
    struct Entry: Codable, Identifiable, Hashable, Sendable {
        var name: String
        var path: String
        var isGit: Bool
        var id: String { path }
    }
    var path: String
    var parent: String?
    var entries: [Entry]
}

enum ItemKind: String, Codable, Sendable {
    case text, thinking, toolUse = "tool_use", toolResult = "tool_result", result, status, error
}

struct ChatItem: Codable, Identifiable, Hashable, Sendable {
    enum Role: String, Codable, Sendable { case user, assistant, system }

    var id: String
    var sessionId: String
    var ts: Date
    var role: Role
    var kind: ItemKind
    var text: String?
    var toolName: String?
    var toolUseId: String?
    var toolInput: JSONValue?
    var toolSummary: String?
    var output: String?
    var isError: Bool?
    var costUsd: Double?
    var durationMs: Double?
    var numTurns: Int?
    var done: Bool
    var parentToolUseId: String?
}

struct DaemonInfo: Codable, Hashable, Sendable {
    var protocolVersion: Int
    var daemonVersion: String
    var claudeVersion: String?
    var hostname: String
    var platform: String
    var directUrl: String?
    var relayConnected: Bool

    private enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol", daemonVersion, claudeVersion, hostname, platform, directUrl, relayConnected
    }
}

struct ContextUsage: Codable, Sendable {
    var percentage: Double
    var totalTokens: Int
    var maxTokens: Int
    var model: String
}

// MARK: - JSON plumbing

/// A loosely typed JSON value for tool inputs and other open-ended payloads.
indirect enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let b = try? container.decode(Bool.self) { self = .bool(b) }
        else if let n = try? container.decode(Double.self) { self = .number(n) }
        else if let s = try? container.decode(String.self) { self = .string(s) }
        else if let a = try? container.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? container.decode([String: JSONValue].self) { self = .object(o) }
        else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "not JSON") }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .number(let n): try container.encode(n)
        case .bool(let b): try container.encode(b)
        case .null: try container.encodeNil()
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// Pretty text for the expanded tool card.
    var prettyPrinted: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self), let text = String(data: data, encoding: .utf8) else { return "" }
        return text
    }
}

enum JSONCoding {
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let date = try? Date(raw, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)) { return date }
            if let date = try? Date(raw, strategy: .iso8601) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "bad date \(raw)")
        }
        return decoder
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(date.formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true)))
        }
        return encoder
    }()
}
