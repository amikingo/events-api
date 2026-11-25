import { randomInt } from "node:crypto";

/**
 * Registration codes (spec §8): random, 8 characters, from an alphabet without look-alikes (no 0, O, 1, I or L), so
 * a guest can read one out or type it. 31^8 ≈ 8.5 × 10^11 combinations; `uq_registration_code` is the backstop.
 * Must match ck_registration_code_format.
 */
export const REGISTRATION_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const REGISTRATION_CODE_LENGTH = 8;
export const REGISTRATION_CODE_PATTERN = /^[A-HJKMNP-Z2-9]{8}$/;

export function generateRegistrationCode(): string {
  let code = "";
  for (let index = 0; index < REGISTRATION_CODE_LENGTH; index += 1) {
    code += REGISTRATION_CODE_ALPHABET.charAt(randomInt(REGISTRATION_CODE_ALPHABET.length));
  }
  return code;
}
