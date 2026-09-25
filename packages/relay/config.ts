import { readFileSync } from 'node:fs';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { xorPriceFromJpy, xorToCodec } from './pricing.js';

/** Publishable merchant configuration; never contains credentials. */
export interface MerchantConfig {
  enabled: boolean;
  fulfillmentMode?: 'on-demand' | 'stocked';
  reviewEveryPaidOrder?: boolean;
  blockedCountries?: string[];
  providers?: { fx?: 'mufg-daily'; shipping?: 'japan-post-ems' };
  sourceMetadata?: Record<string, unknown>;
  version: string;
  merchant: { id: string; name: string; supportEmail: string; supportTelegram?: string; operatorName: string; dispatchPolicy: string; customsPolicy: string; privacyPolicy: string; cancellationPolicy: string };
  pricing: { kind?: 'jpy-fixed-usd' | 'exact-xor'; mode?: 'daily' | 'launch-fixed'; version: string; jpyPerUsd: string; usdPerXor: string; fxSource: string; fxDate: string };
  product: { id: string; name: string; grams: number; packedGrams: number; packagingGrams?: number; stock?: number; priceJpy?: string; priceXor?: string };
  shipping: Array<{ id: string; countries: string[]; maxGrams: number; priceJpy?: string; priceXor?: string; label: string; reviewedAt: string }>;
  chain: { genesisHash: string; assetId: string; decimals: number; denomination: string; recipient: string; rpcUrl: string; archiveRpcUrl?: string; startBlock: number };
  allowedOrigins: string[];
  retentionDays: number;
}
export const NATIVE_XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';

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
  if (!value.enabled) return value;
  for (const item of [value.version, ...Object.values(value.merchant), value.pricing.version]) {
    if (typeof item !== 'string' || !item.trim() || item.length > 5000) throw new Error('Missing merchant configuration');
  }
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
