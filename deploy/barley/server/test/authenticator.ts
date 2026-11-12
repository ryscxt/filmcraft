// A software passkey for tests: ES256, "none" attestation, discoverable. Just enough WebAuthn to
// drive the real @simplewebauthn/server verification end to end.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

// minimal CBOR encoder (ints, byte/text strings, maps)
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}
export function cbor(v: unknown): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
}

export class SoftPasskey {
  id = randomBytes(16);
  privateKey: KeyObject;
  cose: Buffer;
  counter = 0;
  userHandle = "";
  origin: string;
  rpId: string;

  constructor(origin: string, rpId: string) {
    this.origin = origin;
    this.rpId = rpId;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  }

  private clientData(type: string, challenge: string, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** navigator.credentials.create() as JSON, for registration options. */
  create(options: any, origin?: string) {
    this.userHandle = options.user.id;
    const count = Buffer.alloc(4);
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([sha(options.rp.id ?? this.rpId), Buffer.from([0x45]), count, Buffer.alloc(16), credLen, this.id, this.cose]);
    const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: "public-key",
      response: { clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge, origin)), attestationObject: b64u(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get() as JSON, for authentication options. */
  get(options: any, origin?: string) {
    this.counter += 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha(options.rpId ?? this.rpId), Buffer.from([0x05]), count]);
    const cd = this.clientData("webauthn.get", options.challenge, origin);
    const signature = sign("sha256", Buffer.concat([authData, sha(cd)]), this.privateKey);
    return {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: "public-key",
      response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: this.userHandle },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
