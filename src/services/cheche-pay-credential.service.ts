import { chechePayClient, type KeyCheck } from "../clients/cheche-pay.client.js";
import { paymentConfig } from "../config/payment.js";
import { NotFoundError, PaidSalesUnavailableError, ValidationAppError } from "../errors/app-errors.js";
import type { KeyMode } from "../models/order-payment.js";
import { organizationChechePayCredentialRepository } from "../repositories/organization-cheche-pay-credential.repository.js";
import type { RepoOptions } from "../repositories/helpers.js";
import { organizationRepository } from "../repositories/organization.repository.js";
import { secretBox } from "../utils/secret-box.js";
import { ensureFound, runTransaction } from "./helpers.js";

/**
 * An organizer's Cheche Pay v2 keys (Phase 7 step 3b), managed by the platform Super Admin only, as bookings'
 * cheche-pay-credential.service. The secret key decides whose Cheche Pay business receives the money, so an Owner can
 * never change it. Secrets are encrypted at rest (utils/secret-box) and never returned: the admin view shows the mode,
 * the last 4 characters and whether a webhook secret is saved. There is no platform key: an organizer without keys
 * can't sell paid tickets.
 */

const SECRET_KEY_PATTERN = /^sk_(test|live)_[A-Za-z0-9_-]{4,200}$/;

export type ChechePayCredentialDto = {
  organization_id: string;
  configured: boolean;
  is_active: boolean;
  key_mode: KeyMode | null;
  /** e.g. sk_test_••••ab12 */
  secret_key_masked: string | null;
  has_webhook_secret: boolean;
  /** The address to give Cheche Pay for this organizer's webhook; null until PUBLIC_API_BASE_URL is set. */
  webhook_url: string | null;
  /** Active keys, and the server can reach Cheche Pay and read the keys. */
  paid_sales_available: boolean;
  updated_at: Date | null;
};

export type ChechePayCredentialInput = { secret_key?: string | undefined; webhook_secret?: string | null | undefined; is_active?: boolean | undefined };

/** The decrypted keys, for payment calls only (never returned by the API). */
export type ChechePayKeys = { secretKey: string; webhookSecret: string | null; mode: KeyMode };

function serverConfigured(): boolean {
  return paymentConfig.chechePay.financeBaseUrl !== null && secretBox.isConfigured();
}

function webhookUrl(organizationId: string): string | null {
  return paymentConfig.publicApiBaseUrl === null ? null : `${paymentConfig.publicApiBaseUrl}/v1/payments/cheche/webhook/${organizationId}`;
}

function toDto(organizationId: string, row: Awaited<ReturnType<typeof organizationChechePayCredentialRepository.findByOrganization>>): ChechePayCredentialDto {
  if (!row) {
    return {
      organization_id: organizationId,
      configured: false,
      is_active: false,
      key_mode: null,
      secret_key_masked: null,
      has_webhook_secret: false,
      webhook_url: webhookUrl(organizationId),
      paid_sales_available: false,
      updated_at: null,
    };
  }
  return {
    organization_id: organizationId,
    configured: true,
    is_active: row.is_active,
    key_mode: row.key_mode,
    secret_key_masked: `sk_${row.key_mode}_••••${row.secret_key_last4}`,
    has_webhook_secret: row.webhook_secret_encrypted !== null,
    webhook_url: webhookUrl(organizationId),
    paid_sales_available: row.is_active && serverConfigured(),
    updated_at: row.updated_at,
  };
}

function parseSecretKey(value: string): { key: string; mode: KeyMode; last4: string } {
  const key = value.trim();
  if (key.startsWith("pk_")) {
    throw new ValidationAppError("Request validation failed", {
      issues: [{ path: "body.secret_key", message: "That is a publishable key (pk_…). Paste the secret key that starts with sk_test_ or sk_live_.", code: "publishable_key" }],
    });
  }
  if (!SECRET_KEY_PATTERN.test(key)) {
    throw new ValidationAppError("Request validation failed", {
      issues: [{ path: "body.secret_key", message: "A Cheche Pay secret key starts with sk_test_ or sk_live_", code: "invalid_secret_key" }],
    });
  }
  return { key, mode: key.startsWith("sk_live_") ? "live" : "test", last4: key.slice(-4) };
}

function parseWebhookSecret(value: string): string {
  const secret = value.trim();
  if (secret.length < 8 || /\s/.test(secret)) {
    throw new ValidationAppError("Request validation failed", {
      issues: [{ path: "body.webhook_secret", message: "The webhook secret looks incomplete. Copy the whole value (usually whsec_…).", code: "invalid_webhook_secret" }],
    });
  }
  return secret;
}

async function get(organizationId: string): Promise<ChechePayCredentialDto> {
  ensureFound(await organizationRepository.findById(organizationId), "Organization not found");
  return toDto(organizationId, await organizationChechePayCredentialRepository.findByOrganization(organizationId));
}

/**
 * Creates or updates the keys. `secret_key` is required the first time and replaces the key when sent;
 * `webhook_secret`: a string sets it, null clears it, left out keeps it. Needs CHECHE_PAY_CREDENTIALS_KEY.
 */
async function save(organizationId: string, input: ChechePayCredentialInput, actorId: string | null): Promise<ChechePayCredentialDto> {
  if (!secretBox.isConfigured()) {
    throw new PaidSalesUnavailableError("Payment key storage isn't configured on this server", { reason: "CHECHE_PAY_NOT_CONFIGURED" });
  }
  const parsedKey = input.secret_key === undefined ? null : parseSecretKey(input.secret_key);
  const webhookSecret = input.webhook_secret === undefined || input.webhook_secret === null ? input.webhook_secret : parseWebhookSecret(input.webhook_secret);

  await runTransaction(async (transaction) => {
    ensureFound(await organizationRepository.findById(organizationId, { transaction, lock: true }), "Organization not found");
    const existing = await organizationChechePayCredentialRepository.findByOrganization(organizationId, { transaction, lock: true });
    const keyValues = parsedKey ? { secret_key_encrypted: secretBox.encrypt(parsedKey.key), secret_key_last4: parsedKey.last4, key_mode: parsedKey.mode } : {};
    const webhookValues = webhookSecret === undefined ? {} : { webhook_secret_encrypted: webhookSecret === null ? null : secretBox.encrypt(webhookSecret) };
    const activeValues = input.is_active === undefined ? {} : { is_active: input.is_active };
    if (existing) {
      await organizationChechePayCredentialRepository.updateByOrganization(organizationId, { ...keyValues, ...webhookValues, ...activeValues, updated_by: actorId }, { transaction });
      return;
    }
    if (!parsedKey) {
      throw new ValidationAppError("Request validation failed", {
        issues: [{ path: "body.secret_key", message: "Enter the organizer's Cheche Pay secret key", code: "required" }],
      });
    }
    await organizationChechePayCredentialRepository.create(
      {
        organization_id: organizationId,
        key_mode: parsedKey.mode,
        secret_key_encrypted: secretBox.encrypt(parsedKey.key),
        secret_key_last4: parsedKey.last4,
        webhook_secret_encrypted: webhookSecret === undefined || webhookSecret === null ? null : secretBox.encrypt(webhookSecret),
        is_active: input.is_active ?? true,
        created_by: actorId,
        updated_by: actorId,
      },
      { transaction },
    );
  });
  return get(organizationId);
}

/** Removes the keys for good. Payments already started can't be verified afterwards, so prefer switching them off. */
async function remove(organizationId: string): Promise<ChechePayCredentialDto> {
  ensureFound(await organizationRepository.findById(organizationId), "Organization not found");
  if (!(await organizationChechePayCredentialRepository.deleteByOrganization(organizationId))) {
    throw new NotFoundError("This organizer has no Cheche Pay keys");
  }
  return toDto(organizationId, null);
}

/**
 * The decrypted keys, or null when the organizer has none. New payments use active keys only; verifying a payment
 * already started (`includeInactive`) still works after the keys are switched off.
 */
async function resolve(organizationId: string, options: { includeInactive?: boolean } = {}): Promise<ChechePayKeys | null> {
  const row = await organizationChechePayCredentialRepository.findByOrganization(organizationId);
  if (!row || (!row.is_active && options.includeInactive !== true)) return null;
  return {
    secretKey: secretBox.decrypt(row.secret_key_encrypted),
    webhookSecret: row.webhook_secret_encrypted === null ? null : secretBox.decrypt(row.webhook_secret_encrypted),
    mode: row.key_mode,
  };
}

/**
 * The keys for a new payment, or why paid sales are off: 409 paid_sales_unavailable with `reason`
 * CHECHE_PAY_NOT_CONFIGURED (the server) or NO_CHECHE_PAY_KEYS (the organizer).
 */
async function requireForSale(organizationId: string): Promise<ChechePayKeys> {
  if (!serverConfigured()) throw new PaidSalesUnavailableError(undefined, { reason: "CHECHE_PAY_NOT_CONFIGURED" });
  const keys = await resolve(organizationId);
  if (!keys) throw new PaidSalesUnavailableError(undefined, { reason: "NO_CHECHE_PAY_KEYS" });
  return keys;
}

/**
 * Inside checkout's transaction: whether this organizer can sell paid tickets, from the database alone (no
 * decryption, no network). 409 paid_sales_unavailable with the same reasons as requireForSale.
 */
async function assertAvailable(organizationId: string, options: RepoOptions = {}): Promise<void> {
  if (!serverConfigured()) throw new PaidSalesUnavailableError(undefined, { reason: "CHECHE_PAY_NOT_CONFIGURED" });
  const row = await organizationChechePayCredentialRepository.findByOrganization(organizationId, options);
  if (!row?.is_active) throw new PaidSalesUnavailableError(undefined, { reason: "NO_CHECHE_PAY_KEYS" });
}

/** Asks Cheche Pay whether the saved key is accepted, without creating a payment. */
async function check(organizationId: string): Promise<KeyCheck & { key_mode: KeyMode; checked_at: Date }> {
  ensureFound(await organizationRepository.findById(organizationId), "Organization not found");
  const keys = await resolve(organizationId, { includeInactive: true });
  if (!keys) throw new NotFoundError("This organizer has no Cheche Pay keys");
  const result = await chechePayClient.checkKey(keys.secretKey);
  return { ...result, key_mode: keys.mode, checked_at: new Date() };
}

export const chechePayCredentialService = { get, save, remove, resolve, requireForSale, assertAvailable, check };
