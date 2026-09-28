import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../../dist/relay/index.js';
import { syntheticMerchant } from './fixtures.ts';

test('enabled merchant requires a valid public support contact and validates every supplied contact', () => {
  const base = syntheticMerchant();
  const missing = structuredClone(base); delete missing.merchant.supportTelegram;
  assert.throws(() => validateConfig(missing), /Missing public support contact/);
  const emailOnly = structuredClone(missing); emailOnly.merchant.supportEmail = 'help+store@example.test';
  assert.doesNotThrow(() => validateConfig(emailOnly));
  const both = structuredClone(base); both.merchant.supportEmail = 'help@example.test';
  assert.doesNotThrow(() => validateConfig(both));
  for (const supportTelegram of ['', '@example_support', 'https://t.me/example_support', 'example_support?start=bad', 'example/support', 'example support', 'example\nsupport', 'exam', 'a'.repeat(33), '1example_support', null, 123]) {
    const config = structuredClone(both); Object.assign(config.merchant, { supportTelegram });
    assert.throws(() => validateConfig(config), /Invalid public Telegram handle/, String(supportTelegram));
  }
  for (const supportEmail of ['', 'support', 'support@example', 'support@example..test', '.support@example.test', 'support.@example.test', 'support@example.test?subject=bad', 'support@example.test\nBcc:someone@example.test', null, 123]) {
    const config = structuredClone(base); Object.assign(config.merchant, { supportEmail });
    assert.throws(() => validateConfig(config), /Invalid public support email/, String(supportEmail));
  }
});

test('making support email optional does not make merchant identity or policies optional', () => {
  for (const field of ['id', 'name', 'operatorName', 'dispatchPolicy', 'customsPolicy', 'privacyPolicy', 'cancellationPolicy']) {
    for (const badValue of [undefined, '', ' ', 5, 'x'.repeat(5001)]) {
      const config = syntheticMerchant();
      if (badValue === undefined) delete config.merchant[field]; else config.merchant[field] = badValue;
      assert.throws(() => validateConfig(config), /Missing merchant configuration/, `${field}: ${typeof badValue}`);
    }
  }
});
