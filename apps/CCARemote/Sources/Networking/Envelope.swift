// End-to-end envelope, the Swift twin of src/remote/crypto.ts.
// AES-256-GCM, 96-bit random nonce, the device id as additional data.

import CryptoKit
import Foundation

struct Envelope: Codable, Sendable {
    var v: Int = 1
    var n: String
    var c: String
}

enum EnvelopeError: Error, LocalizedError {
    case badKeyLength(Int)
    case malformed
    var errorDescription: String? {
        switch self {
        case .badKeyLength(let n): "pairing key must be 32 bytes, got \(n)"
        case .malformed: "envelope could not be decoded"
        }
    }
}

struct E2EKey: Sendable {
    let key: SymmetricKey

    init(base64url: String) throws {
        guard let raw = Data(base64url: base64url), raw.count == 32 else {
            throw EnvelopeError.badKeyLength(Data(base64url: base64url)?.count ?? 0)
        }
        key = SymmetricKey(data: raw)
    }

    func seal(_ plaintext: Data, deviceId: String) throws -> Envelope {
        let nonce = AES.GCM.Nonce()
        let sealed = try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: Data(deviceId.utf8))
        return Envelope(n: Data(nonce).base64url, c: (sealed.ciphertext + sealed.tag).base64url)
    }

    func open(_ envelope: Envelope, deviceId: String) throws -> Data {
        guard envelope.v == 1, let nonceData = Data(base64url: envelope.n), let combined = Data(base64url: envelope.c), combined.count >= 16 else {
            throw EnvelopeError.malformed
        }
        let nonce = try AES.GCM.Nonce(data: nonceData)
        let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: combined.dropLast(16), tag: combined.suffix(16))
        return try AES.GCM.open(box, using: key, authenticating: Data(deviceId.utf8))
    }
}

extension Data {
    init?(base64url: String) {
        var text = base64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while text.count % 4 != 0 { text.append("=") }
        self.init(base64Encoded: text)
    }

    var base64url: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
