import { b64urlDecode, concat, hkdf, utf8 } from "./crypto";
import type { PushResult } from "../types";

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOutcome {
  result: PushResult;
  status: number | null;
}

const TTL_SECONDS = 60 * 60 * 24 * 28;

/**
 * RFC 8291 (aes128gcm) payload encryption using Web Crypto only.
 * Returns the full binary request body including the aes128gcm header.
 */
async function encryptPayload(
  payload: Uint8Array,
  subscription: PushSubscriptionInput
): Promise<Uint8Array> {
  const userPublicKey = b64urlDecode(subscription.p256dh);
  const authSecret = b64urlDecode(subscription.auth);

  if (userPublicKey.length !== 65 || userPublicKey[0] !== 4) {
    throw new Error("invalid p256dh key");
  }

  const ephemeral = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  )) as CryptoKeyPair;
  const ephemeralPublicRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer
  );

  const userKey = await crypto.subtle.importKey(
    "raw",
    userPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: userKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      ephemeral.privateKey,
      256
    )
  );

  // ikm = HKDF(salt=auth, ikm=ECDH, info="WebPush: info" || 0x00 || ua_pub || as_pub)
  const ikm = await hkdf(
    authSecret,
    ecdhSecret,
    concat(utf8("WebPush: info"), new Uint8Array(1), userPublicKey, ephemeralPublicRaw),
    32
  );

  // prk = HKDF(salt="", ikm=ikm, info="Content-Encoding: auth" || 0x00)
  const prk = await hkdf(
    new Uint8Array(0),
    ikm,
    concat(utf8("Content-Encoding: auth"), new Uint8Array(1)),
    32
  );

  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  const cek = await hkdf(
    salt,
    prk,
    concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array(1)),
    16
  );
  const nonce = await hkdf(
    salt,
    prk,
    concat(utf8("Content-Encoding: nonce"), new Uint8Array(1)),
    12
  );

  // Record padding: plaintext + delimiter byte 0x02 (final record).
  const padded = concat(payload, new Uint8Array([0x02]));

  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, padded)
  );

  // aes128gcm header: salt(16) || dhlen(2 BE) || dh(65) || rs(4 BE = 4096) || idlen(1 = 0)
  const header = concat(
    salt,
    new Uint8Array([0, ephemeralPublicRaw.length]),
    ephemeralPublicRaw,
    new Uint8Array([0, 0, 0x10, 0x00]),
    new Uint8Array([0])
  );

  return concat(header, ciphertext);
}

export async function sendPush(
  subscription: PushSubscriptionInput,
  payloadJson: object,
  vapidAuthHeader: string
): Promise<PushOutcome> {
  try {
    const body = await encryptPayload(
      utf8(JSON.stringify(payloadJson)),
      subscription
    );

    let response: Response;
    try {
      response = await fetch(subscription.endpoint, {
        method: "POST",
        headers: {
          Authorization: vapidAuthHeader,
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "aes128gcm",
          TTL: String(TTL_SECONDS),
          Urgency: "normal",
        },
        body,
      });
    } catch {
      return { result: "temporary_error", status: null };
    }

    if (response.status === 201 || response.status === 202) {
      return { result: "success", status: response.status };
    }
    if (response.status === 404 || response.status === 410) {
      return { result: "gone", status: response.status };
    }
    if (response.status === 429) {
      return { result: "rate_limited", status: response.status };
    }
    if (response.status >= 500) {
      return { result: "temporary_error", status: response.status };
    }
    return { result: "bad_request", status: response.status };
  } catch {
    return { result: "temporary_error", status: null };
  }
}
