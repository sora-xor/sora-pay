import { encodeAddress } from '@polkadot/util-crypto';
import { NATIVE_XOR, type MerchantConfig } from '../../dist/relay/index.js';

/** Return an independent synthetic merchant with exact XOR prices and no production endpoints. */
export function syntheticMerchant(shipping: MerchantConfig['shipping'] = [
  { id: 'example-shipping', countries: ['JP'], maxGrams: 500, priceXor: '1', label: 'Example delivery', reviewedAt: '2026-09-27' },
]): MerchantConfig {
  return {
    enabled: true,
    fulfillmentMode: 'on-demand',
    version: 'synthetic-merchant-v1',
    merchant: {
      id: 'example-merchant', name: 'Example merchant', operatorName: 'Example operator', supportTelegram: 'example_support',
      dispatchPolicy: 'Example dispatch policy', customsPolicy: 'Example customs policy',
      privacyPolicy: 'Example privacy policy', cancellationPolicy: 'Example cancellation policy',
    },
    pricing: { kind: 'exact-xor', mode: 'launch-fixed', version: 'synthetic-prices-v1', jpyPerUsd: '1', usdPerXor: '1', fxSource: 'https://merchant.example/fx', fxDate: '2026-09-27' },
    product: { id: 'example-item', name: 'Example item', grams: 100, packedGrams: 120, packagingGrams: 80, priceXor: '1' },
    shipping: structuredClone(shipping),
    chain: {
      genesisHash: `0x${'a'.repeat(64)}`, assetId: NATIVE_XOR, decimals: 18, denomination: '1',
      recipient: encodeAddress(new Uint8Array(32).fill(2), 69), rpcUrl: 'wss://rpc.merchant.example', startBlock: 100,
    },
    allowedOrigins: ['https://merchant.example'],
    retentionDays: 30,
  };
}
