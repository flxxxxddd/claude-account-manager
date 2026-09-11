// A paired Mac. Metadata lives in UserDefaults; the pairing secrets in the Keychain.

import Foundation
import Security

struct Device: Codable, Identifiable, Hashable, Sendable {
    var id: String            // deviceId from the daemon
    var name: String          // hostname at pairing time, editable
    var relayUrl: URL?
    var directUrl: URL?
    var pairedAt: Date
    /// Prefer the direct socket when reachable (same Mac, or LAN listening on).
    var preferDirect: Bool

    var hasAnyRoute: Bool { relayUrl != nil || directUrl != nil }
}

struct PairingSecrets: Codable, Sendable {
    var clientToken: String
    var e2eKey: String
}

/// Decodes `ccaremote://pair#<base64url json>` from the QR code or a pasted link.
enum PairingLink {
    struct Payload: Decodable {
        var v: Int
        var deviceId: String
        var clientToken: String
        var e2eKey: String
        var relayUrl: String?
        var directUrl: String?
        var hostname: String
    }

    enum Failure: Error, LocalizedError {
        case notAPairingLink, unsupportedVersion(Int), malformed
        var errorDescription: String? {
            switch self {
            case .notAPairingLink: "That is not a CCA Remote pairing link."
            case .unsupportedVersion(let v): "Pairing link version \(v) is newer than this app understands."
            case .malformed: "The pairing link is damaged. Run `cca remote pair` again."
            }
        }
    }

    static func parse(_ text: String) throws -> (Device, PairingSecrets) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let hash = trimmed.range(of: "#"), trimmed.lowercased().hasPrefix("ccaremote://pair") else { throw Failure.notAPairingLink }
        guard let data = Data(base64url: String(trimmed[hash.upperBound...])) else { throw Failure.malformed }
        let payload: Payload
        do { payload = try JSONDecoder().decode(Payload.self, from: data) } catch { throw Failure.malformed }
        guard payload.v == 1 else { throw Failure.unsupportedVersion(payload.v) }
        let device = Device(
            id: payload.deviceId,
            name: payload.hostname.replacingOccurrences(of: ".local", with: ""),
            relayUrl: payload.relayUrl.flatMap(URL.init(string:)),
            directUrl: payload.directUrl.flatMap(URL.init(string:)),
            pairedAt: .now,
            preferDirect: payload.relayUrl == nil
        )
        return (device, PairingSecrets(clientToken: payload.clientToken, e2eKey: payload.e2eKey))
    }
}

/// Keychain wrapper for the secrets; one generic-password item per device.
enum SecretStore {
    private static let service = "app.cca.remote.pairing"

    static func save(_ secrets: PairingSecrets, for deviceId: String) throws {
        let data = try JSONEncoder().encode(secrets)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: deviceId]
        SecItemDelete(query as CFDictionary)
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(insert as CFDictionary, nil)
        if status == errSecMissingEntitlement {
            // An unsigned build (simulator via `CODE_SIGNING_ALLOWED=NO`) has no
            // keychain. Fall back to defaults so development still works; a
            // signed build never takes this path.
            UserDefaults.standard.set(data, forKey: fallbackKey(deviceId))
            return
        }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    private static func fallbackKey(_ deviceId: String) -> String { "secrets.unsigned.\(deviceId)" }

    static func load(for deviceId: String) -> PairingSecrets? {
        if let data = UserDefaults.standard.data(forKey: fallbackKey(deviceId)), let secrets = try? JSONDecoder().decode(PairingSecrets.self, from: data) {
            return secrets
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: deviceId,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(PairingSecrets.self, from: data)
    }

    static func delete(for deviceId: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: deviceId]
        SecItemDelete(query as CFDictionary)
        UserDefaults.standard.removeObject(forKey: fallbackKey(deviceId))
    }
}

#if os(macOS)
/// On the Mac that runs the daemon, pairing needs no QR: read the identity file directly.
enum LocalDaemon {
    static var identityURL: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let ccaHome = ProcessInfo.processInfo.environment["CCA_HOME"].map { URL(fileURLWithPath: $0) } ?? home.appending(path: ".ccacc")
        return ccaHome.appending(path: "remote/identity.json")
    }

    static var settingsURL: URL { identityURL.deletingLastPathComponent().appending(path: "settings.json") }

    struct Identity: Decodable { var deviceId: String; var clientToken: String; var e2eKey: String }
    struct Settings: Decodable { var port: Int?; var relayUrl: String? }

    static func discover() -> (Device, PairingSecrets)? {
        guard let data = try? Data(contentsOf: identityURL), let identity = try? JSONDecoder().decode(Identity.self, from: data) else { return nil }
        let settings = (try? Data(contentsOf: settingsURL)).flatMap { try? JSONDecoder().decode(Settings.self, from: $0) }
        let port = settings?.port ?? 48712
        let device = Device(
            id: identity.deviceId,
            name: Host.current().localizedName ?? "This Mac",
            relayUrl: settings?.relayUrl.flatMap(URL.init(string:)),
            directUrl: URL(string: "ws://127.0.0.1:\(port)/ws"),
            pairedAt: .now,
            preferDirect: true
        )
        return (device, PairingSecrets(clientToken: identity.clientToken, e2eKey: identity.e2eKey))
    }
}
#endif
