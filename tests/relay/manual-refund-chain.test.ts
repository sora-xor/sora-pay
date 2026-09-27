import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApiPromise } from '@polkadot/api';
import { SoraChainReader, ArchiveRequiredError, type MerchantConfig } from '../../dist/relay/index.js';
import { NATIVE_XOR_ASSET_ID } from '../../dist/core/index.js';

const genesis = `0x${'a'.repeat(64)}`, hash = `0x${'b'.repeat(64)}`, tx = `0x${'c'.repeat(64)}`;
const payer = 'cnRsfMpGQ24tCKDLBbwde6NrS9ttrXN3hjX3zMHnVDeQokoBA', recipient = 'cnSG3F5hh3Z5JzV2Qzn6Ez71CL8NUTi68wr9zrjdNedrJht1C';
const amount = '5343596000000000000', fee = '100018400000000000';
const locator = { blockNumber: '100', blockHash: hash, transactionHash: tx, eventIndex: 1 };
const codec = (value: unknown) => ({ toString: () => String(value), toJSON: () => value, toHex: () => String(value) });
const event = (section: string, method: string, data: unknown[], index = 0) => ({ phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => index } }, event: { section, method, data: data.map(codec) } });
/** Direct metadata fixture reproduces native assets.Transfer plus its balances mirror, never a live connection. */
function fixture() {
  const records = [event('balances', 'Transfer', [payer, recipient, amount]), event('assets', 'Transfer', [payer, recipient, { code: NATIVE_XOR_ASSET_ID }, amount]), event('xorFee', 'FeeWithdrawn', [payer, fee]), event('transactionPayment', 'TransactionFeePaid', [payer, fee, '0']), event('system', 'ExtrinsicSuccess', [])];
  const extrinsic = { isSigned: true, hash: codec(tx), signer: codec(payer), method: { section: 'assets', method: 'transfer', args: [codec({ code: NATIVE_XOR_ASSET_ID }), codec(recipient), codec(amount)] } };
  const state = { genesis, canonical: hash, header: hash, height: 100, error: undefined as Error | undefined };
  const api = { genesisHash: { toHex: () => state.genesis }, disconnect: async () => {},
    at: async () => { if (state.error) throw state.error; return { query: { system: { events: async () => records }, timestamp: { now: async () => codec(Date.parse('2026-09-27T12:01:52.000Z')) } } }; },
    rpc: { chain: { getFinalizedHead: async () => codec(hash), getHeader: async () => ({ number: { toNumber: () => state.height } }), getBlockHash: async () => codec(state.canonical), getBlock: async () => ({ block: { header: { hash: codec(state.header) }, extrinsics: [extrinsic] } }) } },
  } as unknown as ApiPromise;
  const config = { chain: { genesisHash: genesis, assetId: NATIVE_XOR_ASSET_ID } } as MerchantConfig;
  return { records, extrinsic, state, api, config, reader: new SoraChainReader(api, config) };
}
test('manual reader returns truthful absent reference and one corroborated fee from direct native transfer', async () => {
  const f = fixture();
  assert.deepEqual(await f.reader.manualRefund(locator), { chainGenesisHash: genesis, assetId: NATIVE_XOR_ASSET_ID, payer, recipient, amountCodec: amount, reference: null, transferKind: 'assets-transfer', transactionHash: tx, blockHash: hash, blockNumber: '100', eventIndex: 1, successful: true, finalized: true, finalizedAt: '2026-09-27T12:01:52.000Z', networkFee: { payer, assetId: NATIVE_XOR_ASSET_ID, amountCodec: fee, eventIndex: 2 } });
  assert.deepEqual((await f.reader.block(100)).transfers, [], 'automatic scanner still ignores unreferenced assets transfers');
});
test('manual reader cannot bind balances mirror, wrong transaction, malformed locator, unfinalized or noncanonical block', async () => {
  for (const change of [{ eventIndex: 0 }, { eventIndex: -1 }, { eventIndex: 1.5 }, { eventIndex: 90 }, { transactionHash: `0x${'d'.repeat(64)}` }, { blockHash: `0x${'d'.repeat(64)}` }, { blockNumber: '101' }, { blockNumber: '0100' }, { blockNumber: '9007199254740992' }]) await assert.rejects(fixture().reader.manualRefund({ ...locator, ...change }));
  const wrongGenesis = fixture(); wrongGenesis.state.genesis = `0x${'d'.repeat(64)}`; await assert.rejects(wrongGenesis.reader.manualRefund(locator), /genesis/);
  const wrongHeader = fixture(); wrongHeader.state.header = `0x${'d'.repeat(64)}`; await assert.rejects(wrongHeader.reader.manualRefund(locator), /header hash/);
});
test('manual reader rejects nested/unsigned/failed/ambiguous or call-event-mirror mismatched transfers', async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => { f.extrinsic.method.section = 'utility'; f.extrinsic.method.method = 'batch'; },
    (f: ReturnType<typeof fixture>) => { f.extrinsic.isSigned = false; },
    (f: ReturnType<typeof fixture>) => { f.extrinsic.signer = codec(recipient); },
    (f: ReturnType<typeof fixture>) => { f.extrinsic.method.args[0] = codec({ code: `0x${'0'.repeat(64)}` }); },
    (f: ReturnType<typeof fixture>) => { f.extrinsic.method.args[1] = codec(payer); },
    (f: ReturnType<typeof fixture>) => { f.extrinsic.method.args[2] = codec('1'); },
    (f: ReturnType<typeof fixture>) => { f.extrinsic.method.args.push(codec('extra')); },
    (f: ReturnType<typeof fixture>) => { f.records[0]!.event.data[2] = codec('1'); },
    (f: ReturnType<typeof fixture>) => { f.records[1]!.event.data[2] = codec({ code: `0x${'0'.repeat(64)}` }); },
    (f: ReturnType<typeof fixture>) => { f.records.push(f.records[1]!); },
    (f: ReturnType<typeof fixture>) => { f.records.push(f.records[0]!); },
    (f: ReturnType<typeof fixture>) => { f.records.push(event('system', 'ExtrinsicFailed', [])); },
    (f: ReturnType<typeof fixture>) => { f.records[4] = event('system', 'ExtrinsicSuccess', [], 1); },
  ];
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(f.reader.manualRefund(locator)); }
});
test('fee mirrors are never summed; missing/ambiguous/mismatched native fee evidence stays absent', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.records[2] = event('xorFee', 'FeeWithdrawn', [payer, '1']); },
    (f: ReturnType<typeof fixture>) => { f.records[3] = event('transactionPayment', 'TransactionFeePaid', [payer, fee, '1']); },
    (f: ReturnType<typeof fixture>) => { f.records[3] = event('transactionPayment', 'TransactionFeePaid', [recipient, fee, '0']); },
    (f: ReturnType<typeof fixture>) => { f.records.push(f.records[2]!); },
  ]) { const f = fixture(); change(f); const proof = await f.reader.manualRefund(locator); assert.equal(proof.amountCodec, amount); assert.equal(proof.networkFee, undefined); }
});
test('manual historical lookup uses only matching approved archive and leaves scanner state untouched', async () => {
  const primary = fixture(); primary.state.error = new Error('State already discarded for block');
  await assert.rejects(primary.reader.manualRefund(locator), ArchiveRequiredError);
  const archive = fixture(); const reader = new SoraChainReader(primary.api, primary.config, archive.api);
  assert.equal((await reader.manualRefund(locator)).reference, null);
  archive.state.genesis = `0x${'d'.repeat(64)}`; await assert.rejects(reader.manualRefund(locator), /genesis/);
  archive.state.genesis = genesis; archive.state.canonical = `0x${'d'.repeat(64)}`; await assert.rejects(reader.manualRefund(locator), /hash/);
  archive.state.canonical = hash; archive.state.header = `0x${'d'.repeat(64)}`; await assert.rejects(reader.manualRefund(locator), /header hash/);
});
