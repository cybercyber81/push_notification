import { b64urlDecode, b64urlEncode, utf8 } from "./crypto";

export interface VapidKeypair {
  /** base64url raw (uncompressed) public key — safe for browsers. */
  publicKey: string;
  /** base64 of PKCS#8 private key — must be encrypted before storage. */
  privateKeyPkcs8: string;
}

export async function generateVapidKeypair(): Promise<VapidKeypair> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;

  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer
  );
  const privateKey = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer
  );

  let binary = "";
  for (const b of privateKey) binary += String.fromCharCode(b);
  return {
    publicKey: b64urlEncode(publicKey),
    privateKeyPkcs8: btoa(binary),
  };
}

/**
 * Build the VAPID Authorization header for a push request.
 * JWT is ES256-signed per RFC 8292.
 */
export async function buildVapidHeader(
  endpoint: string,
  privateKeyPkcs8: string,
  publicKey: string,
  subject: string
): Promise<string> {
  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);

  const header = b64urlEncode(
    utf8(JSON.stringify({ typ: "JWT", alg: "ES256" }))
  );
  const claims = b64urlEncode(
    utf8(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: subject }))
  );
  const signingInput = `${header}.${claims}`;

  const keyData = b64urlDecode(privateKeyPkcs8.replace(/-/g, "+").replace(/_/g, "/"));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  // Web Crypto returns the signature as raw r||s (64 bytes), which is
  // exactly what JOSE/ES256 requires.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      utf8(signingInput)
    )
  );

  return `vapid t=${signingInput}.${b64urlEncode(signature)}, k=${publicKey}`;
}
