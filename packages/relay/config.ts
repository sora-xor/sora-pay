import { readFileSync } from 'node:fs';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { xorPriceFromJpy, xorToCodec } from './pricing.js';
import { storageMinimumBytes } from './storage-admission.js';

/** Policy versions are snapshotted per order; missing historical snapshots retain full refunds. */
export type RefundPolicy = { version: 1; mode: 'full' } | { version: 2; mode: 'net-network-fee' };

/** Resolve only known versions; never reinterpret an existing order using current merchant settings. */
export function resolveRefundPolicy(policy?: RefundPolicy): RefundPolicy {
  if (policy === undefined) return { version: 1, mode: 'full' };
  if (policy && ((policy.version === 1 && policy.mode === 'full') || (policy.version === 2 && policy.mode === 'net-network-fee'))) return { version: policy.version, mode: policy.mode } as RefundPolicy;
  throw new Error('Invalid refund policy');
}

/** Publishable merchant configuration; never contains credentials. */
export interface MerchantConfig {
  enabled: boolean;
  /** Optional exact available-byte floor for new orders and customer signing leases. */
  storageMinimumFreeBytes?: string;
  refundPolicy?: RefundPolicy;
  fulfillmentMode?: 'on-demand' | 'stocked';
  reviewEveryPaidOrder?: boolean;
  blockedCountries?: string[];
  /** Optional reviewed destinations for new orders; an empty list permits inquiries only. */
  approvedShippingCountries?: string[];
  /** Require an individual-recipient, personal-consumption and no-resale confirmation for new orders. */
  personalUseOnly?: boolean;
  providers?: { fx?: 'mufg-daily'; shipping?: 'japan-post-ems' };
  sourceMetadata?: Record<string, unknown>;
  version: string;
  merchant: { id: string; name: string; supportEmail?: string; supportTelegram?: string; operatorName: string; dispatchPolicy: string; customsPolicy: string; privacyPolicy: string; cancellationPolicy: string };
  pricing: { kind?: 'jpy-fixed-usd' | 'exact-xor'; mode?: 'daily' | 'launch-fixed'; version: string; jpyPerUsd: string; usdPerXor: string; fxSource: string; fxDate: string };
  product: { id: string; name: string; grams: number; packedGrams: number; packagingGrams?: number; stock?: number; priceJpy?: string; priceXor?: string };
  shipping: Array<{ id: string; countries: string[]; maxGrams: number; priceJpy?: string; priceXor?: string; label: string; reviewedAt: string }>;
  chain: { genesisHash: string; assetId: string; decimals: number; denomination: string; recipient: string; rpcUrl: string; archiveRpcUrl?: string; startBlock: number };
  allowedOrigins: string[];
  retentionDays: number;
}
export const NATIVE_XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
// ISO 3166-1 alpha-2 assignments; aliases and unassigned two-letter strings are not approvals.
const shippingCountryCodes = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));

/** Canonical SS58 makes alternate encodings of one account compare identically. */
export function accountAddress(value: string): string {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Invalid account');
  const bytes = decodeAddress(value);
  if (bytes.length !== 32) throw new Error('Expected AccountId32');
  return encodeAddress(bytes, 69);
}

/** Fail closed before opening a payment route if any merchant input is missing. */
export function validateConfig(value: MerchantConfig): MerchantConfig {
  if (!value || typeof value.enabled !== 'boolean') throw new Error('Invalid configuration');
  if (value.personalUseOnly !== undefined && typeof value.personalUseOnly !== 'boolean') throw new Error('Invalid personal-use policy');
  storageMinimumBytes(value.storageMinimumFreeBytes);
  resolveRefundPolicy(value.refundPolicy);
  const approved = value.approvedShippingCountries;
  if (approved !== undefined && (!Array.isArray(approved) || approved.some((code) => typeof code !== 'string' || !shippingCountryCodes.has(code)) || new Set(approved).size !== approved.length)) throw new Error('Invalid approved shipping countries');
  if (!value.enabled) return value;
  const requiredMerchantFields = ['id', 'name', 'operatorName', 'dispatchPolicy', 'customsPolicy', 'privacyPolicy', 'cancellationPolicy'] as const;
  for (const item of [value.version, ...requiredMerchantFields.map((field) => value.merchant?.[field]), value.pricing?.version]) {
    if (typeof item !== 'string' || !item.trim() || item.length > 5000) throw new Error('Missing merchant configuration');
  }
  // Public support is separate from private notification credentials and customer contact details.
  const { supportEmail, supportTelegram } = value.merchant;
  if (supportEmail === undefined && supportTelegram === undefined) throw new Error('Missing public support contact');
  if (supportEmail !== undefined && (typeof supportEmail !== 'string' || supportEmail.length > 254 || !/^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(supportEmail) || supportEmail.split('@')[0]!.endsWith('.') || supportEmail.includes('..'))) throw new Error('Invalid public support email');
  if (supportTelegram !== undefined && (typeof supportTelegram !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(supportTelegram))) throw new Error('Invalid public Telegram handle');
  if (value.pricing.kind !== 'exact-xor' && (!/^https:\/\//.test(value.pricing.fxSource) || !/^\d{4}-\d{2}-\d{2}$/.test(value.pricing.fxDate))) throw new Error('Invalid FX snapshot');
  merchantPrice(value, value.product);
  if (value.chain.assetId.toLowerCase() !== NATIVE_XOR || !/^0x[a-fA-F0-9]{64}$/.test(value.chain.genesisHash)) throw new Error('Invalid native XOR chain');
  if (!Number.isInteger(value.chain.decimals) || value.chain.decimals < 6 || value.chain.decimals > 30 || !/^[1-9]\d*$/.test(value.chain.denomination)) throw new Error('Invalid denomination');
  if (!Number.isSafeInteger(value.chain.startBlock) || value.chain.startBlock < 0) throw new Error('Missing chain start block');
  if (!/^wss:\/\//.test(value.chain.rpcUrl)) throw new Error('Use an approved TLS RPC endpoint');
  if (value.chain.archiveRpcUrl !== undefined && !/^wss:\/\//.test(value.chain.archiveRpcUrl)) throw new Error('Use an explicitly approved TLS archive RPC endpoint');
  value.chain.genesisHash = value.chain.genesisHash.toLowerCase(); value.chain.assetId = value.chain.assetId.toLowerCase();
  value.chain.recipient = accountAddress(value.chain.recipient);
  if ((value.fulfillmentMode !== 'on-demand' && (!Number.isSafeInteger(value.product.stock) || value.product.stock! < 0)) || !Number.isSafeInteger(value.product.packedGrams) || value.product.packedGrams < value.product.grams || !Number.isSafeInteger(value.product.grams) || value.product.grams <= 0) throw new Error('Invalid product inventory');
  if (value.product.packagingGrams !== undefined && (!Number.isSafeInteger(value.product.packagingGrams) || value.product.packagingGrams < 0)) throw new Error('Invalid parcel overhead');
  if (!value.product.id || !value.product.name || !value.allowedOrigins.length || !Number.isInteger(value.retentionDays) || value.retentionDays < 1) throw new Error('Incomplete store configuration');
  for (const origin of value.allowedOrigins) if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('Exact HTTPS origins required');
  const ids = new Set<string>();
  for (const rate of value.shipping) {
    if (!rate.id || ids.has(rate.id) || !rate.label || !/^\d{4}-\d{2}-\d{2}$/.test(rate.reviewedAt) || !Number.isSafeInteger(rate.maxGrams) || rate.maxGrams < value.product.packedGrams || !rate.countries.length || rate.countries.some((c) => !/^[A-Z]{2}$/.test(c))) throw new Error('Invalid shipping rate');
    ids.add(rate.id);
    merchantPrice(value, rate, true);
  }
  return value;
}

/** Read a private deployment's explicitly supplied merchant configuration. */
export function loadConfig(path: string): MerchantConfig {
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')) as MerchantConfig);
}

/** Merchant-specific policy is configuration, while the relay also accepts generic exact XOR prices. */
export function merchantPrice(config: MerchantConfig, item: { priceJpy?: string; priceXor?: string }, allowZero = false): string {
  const value = config.pricing.kind === 'exact-xor' ? item.priceXor : xorPriceFromJpy(item.priceJpy ?? '', config.pricing.jpyPerUsd, config.pricing.usdPerXor);
  if (typeof value !== 'string') throw new Error('Missing merchant price');
  const codec = BigInt(xorToCodec(value, config.chain.decimals, config.chain.denomination));
  if (!allowZero && codec === 0n) throw new Error('Product price must be positive');
  return value;
}
