/**
 * End-to-end envelope for frames that cross the relay.
 *
 * The relay is our own Cloudflare Worker, but it still sees every byte, so
 * frames are sealed with AES-256-GCM under a key that only the daemon and
 * paired apps hold (it travels in the pairing QR code). The Worker forwards
 * ciphertext it cannot read; a compromised relay can drop or replay frames
 * but not read or forge them. Replays are harmless: every request carries a
 * client-chosen id and every event is idempotent on the app side.
 *
 * WebCrypto only, so the same code runs under Bun and Node.
 */

export interface Envelope {
  v: 1;
  /** 96-bit nonce, base64url. */
  n: string;
  /** ciphertext || tag, base64url. */
  c: string;
}

const NONCE_BYTES = 12;

export type Bytes = Uint8Array<ArrayBuffer>;

export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(text: string): Bytes {
  const buf = Buffer.from(text, "base64url");
  const out = new Uint8Array(new ArrayBuffer(buf.byteLength));
  out.set(buf);
  return out;
}

export async function importKey(raw: Bytes): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new Error(`E2E key must be 32 bytes, got ${raw.byteLength}`);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** `aad` binds the ciphertext to one device so a frame cannot be re-routed. */
export async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<Envelope> {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { v: 1, n: toBase64Url(nonce), c: toBase64Url(new Uint8Array(ct)) };
}

export async function open(key: CryptoKey, envelope: Envelope, aad: string): Promise<string> {
  if (envelope.v !== 1) throw new Error(`unsupported envelope version ${String(envelope.v)}`);
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64Url(envelope.n),
      additionalData: new TextEncoder().encode(aad),
    },
    key,
    fromBase64Url(envelope.c),
  );
  return new TextDecoder().decode(pt);
}

export function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Envelope).v === 1 &&
    typeof (value as Envelope).n === "string" &&
    typeof (value as Envelope).c === "string"
  );
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

/** Constant-time string compare for tokens. */
export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
