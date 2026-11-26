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

/**
 * Phase 7: an order's public reference, 10 characters from the same alphabet, so it never looks like a ticket code
 * (8). Orders made from registrations that existed before Phase 7 reuse that registration's code.
 * `uq_ticket_order_reference` is the backstop; must match ck_ticket_order_reference_format.
 */
export const ORDER_REFERENCE_LENGTH = 10;

export function generateOrderReference(): string {
  let reference = "";
  for (let index = 0; index < ORDER_REFERENCE_LENGTH; index += 1) {
    reference += REGISTRATION_CODE_ALPHABET.charAt(randomInt(REGISTRATION_CODE_ALPHABET.length));
  }
  return reference;
}
