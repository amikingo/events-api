import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { paymentConfig } from "../config/payment.js";
import { PaidSalesUnavailableError } from "../errors/app-errors.js";

/**
 * Encrypts small secrets (an organizer's Cheche Pay keys) for storage, as bookings' utils/secret-box.js:
 * AES-256-GCM with the 32-byte CHECHE_PAY_CREDENTIALS_KEY (64 hex characters or base64).
 * Stored format: v1:<iv>:<tag>:<ciphertext>, each base64. Errors never contain the secret or the key.
 */

const VERSION = "v1";

function keyFrom(raw: string | null): Buffer {
  if (raw === null) {
    throw new PaidSalesUnavailableError("Payment key storage isn't configured on this server", { reason: "CHECHE_PAY_NOT_CONFIGURED" });
  }
  // env.ts already checked the shape; this only decodes it.
  return /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
}

/** Whether keys can be stored and read on this server. */
function isConfigured(): boolean {
  return paymentConfig.credentialsKey !== null;
}

function encrypt(plaintext: string, rawKey: string | null = paymentConfig.credentialsKey): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(rawKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

/** A wrong key or tampered data is refused with a message that names neither. */
function decrypt(stored: string, rawKey: string | null = paymentConfig.credentialsKey): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new PaidSalesUnavailableError("A stored payment key has an unknown format", { reason: "CHECHE_PAY_KEY_UNREADABLE" });
  }
  const [, iv, tag, ciphertext] = parts as [string, string, string, string];
  const key = keyFrom(rawKey);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // A changed CHECHE_PAY_CREDENTIALS_KEY, or data altered in the database.
    throw new PaidSalesUnavailableError("A stored payment key couldn't be read on this server", { reason: "CHECHE_PAY_KEY_UNREADABLE" });
  }
}

export const secretBox = { isConfigured, encrypt, decrypt };
