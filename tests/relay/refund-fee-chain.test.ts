import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiPromise } from '@polkadot/api';
import { SoraChainReader, type MerchantConfig } from '../../dist/relay/index.js';
import { NATIVE_XOR_ASSET_ID, type PaymentRequest } from '../../dist/core/index.js';

const genesis = `0x${'a'.repeat(64)}`;
const hash = `0x${'2'.repeat(64)}`;
const payer = 'cnRsfMpGQ24tCKDLBbwde6NrS9ttrXN3hjX3zMHnVDeQokoBA';
const recipient = 'cnSG3F5hh3Z5JzV2Qzn6Ez71CL8NUTi68wr9zrjdNedrJht1C';
const reference = `sp_${'b'.repeat(32)}`;
const now = Date.parse('2026-09-26T00:00:00.000Z');
const codec = (value: unknown) => ({ toString: () => String(value), toHex: () => String(value), toJSON: () => value });
const record = (section: string, method: string, values: unknown[], index = 0) => ({ phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => index } }, event: { section, method, data: values.map(codec) } });
const request: PaymentRequest = { version: 1, merchant: { id: 'merchant', name: 'Merchant' }, chainGenesisHash: genesis, assetId: NATIVE_XOR_ASSET_ID, payer, recipient, reference, amountCodec: '1000', decimals: 18, denomination: '1', expiresAt: new Date(now + 60_000).toISOString() };

/** A finalized RPC fixture records serialized call amounts, signatures and queried block state. */
function fixture(options: { fees?: string[]; records?: ReturnType<typeof record>[]; signer?: string; method?: string; signed?: boolean; extensions?: string[]; genesis?: string; spec?: string; denomination?: string } = {}) {
  const calls: unknown[][] = []; const signOptions: Record<string, unknown>[] = []; const queriedLengths: number[] = []; const stateHashes: string[] = [];
  const version = { specVersion: codec('131'), transactionVersion: codec('1') };
  const transfer = record('liquidityProxy', 'XorlessTransfer', [{ code: NATIVE_XOR_ASSET_ID }, payer, recipient, '1000', '0x' + Buffer.from(reference).toString('hex')]);
  const records = options.records ?? [transfer, record('xorFee', 'FeeWithdrawn', [payer, '100']), record('transactionPayment', 'TransactionFeePaid', [payer, '100', '0']), record('system', 'ExtrinsicSuccess', [])];
  let queryCount = 0;
  const at = {
    runtimeVersion: version,
    registry: { signedExtensions: options.extensions ?? ['CheckNonce', 'ChargeTransactionPayment'], createType: (name: string, value: unknown) => ({ name, value }) },
    query: { system: { account: async () => codec({ nonce: 7 }), events: async () => records }, timestamp: { now: async () => codec(now) }, denomination: { denominator: async () => codec(options.denomination ?? '1') }, assets: { assetInfosV2: async () => codec({ precision: 18 }) } },
    call: { transactionPaymentApi: { queryInfo: async (bytes: Uint8Array, length: number) => { assert.equal(bytes[0], 1); assert.equal(length, bytes.length); queriedLengths.push(length); return { partialFee: codec(options.fees?.[queryCount++] ?? '100') }; } } },
    tx: () => { let fake = false; return { signFake: (account: string, opts: Record<string, unknown>) => { assert.equal(account, payer); signOptions.push(opts); fake = true; }, toU8a: () => new Uint8Array(fake ? [1, 2, 3] : [0]) }; },
  };
  const api = {
    genesisHash: codec(options.genesis ?? genesis), runtimeVersion: version,
    tx: { liquidityProxy: { xorlessTransfer: (...args: unknown[]) => { calls.push(args); return { toU8a: () => new Uint8Array([0]) }; } } },
    at: async (h: { toHex(): string }) => { stateHashes.push(typeof h === 'string' ? h : h.toHex()); return at; },
    rpc: { state: { getRuntimeVersion: async () => ({ ...version, specVersion: codec(options.spec ?? '131') }) }, chain: {
      getFinalizedHead: async () => codec(hash), getHeader: async () => ({ number: { toNumber: () => 100, toString: () => '100' } }), getBlockHash: async () => codec(hash),
      getBlock: async () => ({ block: { header: { hash: codec(hash) }, extrinsics: [{ hash: codec(`0x${'3'.repeat(64)}`), isSigned: options.signed ?? true, signer: codec(options.signer ?? payer), method: { section: options.method ? 'utility' : 'liquidityProxy', method: options.method ?? 'xorlessTransfer' } }] } }),
    } },
  } as unknown as ApiPromise;
  const config = { chain: { genesisHash: genesis, recipient: payer, assetId: NATIVE_XOR_ASSET_ID, denomination: '1', decimals: 18 } } as MerchantConfig;
  return { reader: new SoraChainReader(api, config, undefined, () => now), calls, signOptions, queriedLengths, stateHashes, transfer };
}

test('trusted fee quote re-encodes net XOR with exact reference and queries signed-length at finalized state', async () => {
  const f = fixture();
  assert.deepEqual(await f.reader.quoteRefund(request, '1000'), { amountCodec: '900', feeCodec: '100', blockHash: hash, blockNumber: '100', expiresAt: new Date(now + 120_000).toISOString() });
  assert.deepEqual(f.calls.map((args) => args[3]), ['1000', '900']);
  for (const args of f.calls) assert.deepEqual(args, [0, { code: NATIVE_XOR_ASSET_ID }, recipient, args[3], '0', '0', [], 'Disabled', '0x' + Buffer.from(reference).toString('hex')]);
  assert.equal(f.signOptions[0]?.nonce, 7); assert.equal(f.signOptions[0]?.tip, 0);
  const era = f.signOptions[0]?.era as { name: string; value: { period: number; current: { toString(): string } } };
  assert.equal(era.name, 'ExtrinsicEra'); assert.equal(era.value.period, 64); assert.equal(era.value.current.toString(), '100');
  assert.deepEqual(f.queriedLengths, [3, 3]); assert.ok(f.stateHashes.every((value) => value === hash));
});

test('fee estimator refuses foreign chain/payer/configuration, unsupported fee asset extension and excessive fee', async () => {
  await assert.rejects(fixture().reader.quoteRefund({ ...request, payer: recipient, recipient: payer }, '1000'), /configuration/);
  await assert.rejects(fixture().reader.quoteRefund(request, '999'), /configuration/);
  await assert.rejects(fixture().reader.quoteRefund({ ...request, expiresAt: new Date(now - 1).toISOString() }, '1000'), /configuration/);
  await assert.rejects(fixture({ genesis: `0x${'e'.repeat(64)}` }).reader.quoteRefund(request, '1000'), /genesis/);
  await assert.rejects(fixture({ spec: '132' }).reader.quoteRefund(request, '1000'), /runtime/);
  await assert.rejects(fixture({ denomination: '1000' }).reader.quoteRefund(request, '1000'), /denomination/);
  await assert.rejects(fixture({ extensions: ['ChargeTransactionPayment2'] }).reader.quoteRefund(request, '1000'), /extension/);
  await assert.rejects(fixture({ fees: ['1000'] }).reader.quoteRefund(request, '1000'), /does not cover/);
  await assert.rejects(fixture({ fees: ['0'] }).reader.quoteRefund(request, '1000'), /invalid_amount/);
  await assert.rejects(fixture({ fees: ['100', '101', '100', '101'] }).reader.quoteRefund(request, '1000'), /converge/);
});

test('FeeWithdrawn and TransactionFeePaid corroborate a single fee; balance events cannot double count', async () => {
  const f = fixture(); const transfers = (await f.reader.block(100)).transfers;
  assert.deepEqual(transfers[0]?.networkFee, { payer, assetId: NATIVE_XOR_ASSET_ID, amountCodec: '100', eventIndex: 1 });
  const more = fixture({ records: [f.transfer, record('balances', 'Withdraw', [payer, '100']), record('xorFee', 'FeeWithdrawn', [payer, '100']), record('transactionPayment', 'TransactionFeePaid', [payer, '100', '0']), record('balances', 'Rescinded', ['100']), record('system', 'ExtrinsicSuccess', [])] });
  assert.equal((await more.reader.block(100)).transfers[0]?.networkFee?.amountCodec, '100');
});

test('ambiguous fees, tips, wrong phase/payer, nested calls and unknown metadata do not permit deduction', async () => {
  const f = fixture(); const success = record('system', 'ExtrinsicSuccess', []);
  const fee = record('xorFee', 'FeeWithdrawn', [payer, '100']); const paid = record('transactionPayment', 'TransactionFeePaid', [payer, '100', '0']);
  for (const records of [
    [f.transfer, fee, success], [f.transfer, fee, fee, paid, success],
    [f.transfer, fee, record('transactionPayment', 'TransactionFeePaid', [payer, '101', '0']), success],
    [f.transfer, fee, record('transactionPayment', 'TransactionFeePaid', [payer, '100', '1']), success],
    [f.transfer, record('xorFee', 'FeeWithdrawn', [recipient, '100']), paid, success],
    [f.transfer, record('xorFee', 'FeeWithdrawn', [payer, NATIVE_XOR_ASSET_ID, '100']), paid, success],
    [f.transfer, fee, record('transactionPayment', 'TransactionFeePaid', [payer, '100', '0'], 1), success],
    [f.transfer, f.transfer, fee, paid, success],
  ]) for (const transfer of (await fixture({ records }).reader.block(100)).transfers) assert.equal(transfer.networkFee, undefined);
  for (const options of [{ signer: recipient }, { method: 'batch' }, { signed: false }]) assert.equal((await fixture(options).reader.block(100)).transfers[0]?.networkFee, undefined);
});
