import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OrderStore, validateConfig } from '../../dist/relay/index.js';

const polkaswapTemplate = JSON.parse(readFileSync(new URL('../../deploy/merchant.polkaswap.json.example', import.meta.url), 'utf8'));

test('both disabled merchant examples publish only the community Telegram support contact', () => {
  for (const filename of ['merchant.polkaswap.json.example', 'merchant.disabled.json.example']) {
    const config = JSON.parse(readFileSync(new URL(`../../deploy/${filename}`, import.meta.url), 'utf8'));
    assert.equal(config.enabled, false);
    assert.equal(config.merchant.supportTelegram, 'sora_xor');
    assert.equal(Object.hasOwn(config.merchant, 'supportEmail'), false);
    assert.equal(config.product.priceXor, '1.759225');
  }
});

test('Telegram-only Polkaswap catalog has no public email or personal handle and keeps fixed XOR prices', () => {
  const config = validateConfig({ ...structuredClone(polkaswapTemplate), enabled: true });
  const store = new OrderStore(':memory:', config, Buffer.alloc(32, 7));
  try {
    const catalog = store.catalog();
    assert.equal(catalog.merchant.supportTelegram, 'sora_xor');
    assert.equal(Object.hasOwn(catalog.merchant, 'supportEmail'), false);
    assert.equal(catalog.product.priceXor, '1.759225');
    assert.deepEqual(catalog.shipping.map((rate) => rate.priceXor), polkaswapTemplate.shipping.map((rate) => rate.priceXor));
    for (const privateContact of ['takemiya@sora.org', 'mtakemiya']) assert.equal(JSON.stringify(catalog).includes(privateContact), false);
    assert.equal(Object.hasOwn(config, 'notification'), false);
  } finally { store.close(); }
});

test('enabled merchant requires a valid public support contact and validates every supplied contact', () => {
  const base = { ...structuredClone(polkaswapTemplate), enabled: true };
  const missing = structuredClone(base); delete missing.merchant.supportTelegram;
  assert.throws(() => validateConfig(missing), /Missing public support contact/);
  const emailOnly = structuredClone(missing); emailOnly.merchant.supportEmail = 'help+store@example.test';
  assert.doesNotThrow(() => validateConfig(emailOnly));
  const both = structuredClone(base); both.merchant.supportEmail = 'help@example.test';
  assert.doesNotThrow(() => validateConfig(both));
  for (const supportTelegram of ['', '@sora_xor', 'https://t.me/sora_xor', 'sora_xor?start=bad', 'sora/xor', 'sora xor', 'sora\nxor', 'sora', 'a'.repeat(33), '1sora_xor', null, 123]) {
    const config = structuredClone(both); config.merchant.supportTelegram = supportTelegram;
    assert.throws(() => validateConfig(config), /Invalid public Telegram handle/, String(supportTelegram));
  }
  for (const supportEmail of ['', 'support', 'support@example', 'support@example..test', '.support@example.test', 'support.@example.test', 'support@example.test?subject=bad', 'support@example.test\nBcc:someone@example.test', null, 123]) {
    const config = structuredClone(base); config.merchant.supportEmail = supportEmail;
    assert.throws(() => validateConfig(config), /Invalid public support email/, String(supportEmail));
  }
});

test('making support email optional does not make merchant identity or policies optional', () => {
  for (const field of ['id', 'name', 'operatorName', 'dispatchPolicy', 'customsPolicy', 'privacyPolicy', 'cancellationPolicy']) {
    for (const badValue of [undefined, '', ' ', 5, 'x'.repeat(5001)]) {
      const config = { ...structuredClone(polkaswapTemplate), enabled: true };
      if (badValue === undefined) delete config.merchant[field]; else config.merchant[field] = badValue;
      assert.throws(() => validateConfig(config), /Missing merchant configuration/, `${field}: ${typeof badValue}`);
    }
  }
});
