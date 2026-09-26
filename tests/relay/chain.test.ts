import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiPromise } from '@polkadot/api';
import { ArchiveRequiredError, SoraChainReader, scanFinalized } from '../../dist/relay/index.js';
import type { MerchantConfig, OrderStore } from '../../dist/relay/index.js';
import { NATIVE_XOR_ASSET_ID } from '../../dist/core/index.js';

const genesis = `0x${'a'.repeat(64)}`;
const blockHash = `0x${'2'.repeat(64)}`;
const transactionHash = `0x${'1'.repeat(64)}`;
const payer = 'cnRsfMpGQ24tCKDLBbwde6NrS9ttrXN3hjX3zMHnVDeQokoBA';
const recipient = 'cnSG3F5hh3Z5JzV2Qzn6Ez71CL8NUTi68wr9zrjdNedrJht1C';
const reference = `sp_${'b'.repeat(32)}`;

/** Metadata-backed codec fixture; no RPC connections are made. */
function codec(value: unknown) {
  return { toString: () => String(value), toHex: () => String(value), toJSON: () => value };
}

/** Success/failure events remain correlated to the exact extrinsic index. */
function record(section: string, method: string, values: unknown[], index = 0) {
  return { phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => index } }, event: { section, method, data: values.map(codec) } };
}

/** Build an isolated portable-metadata API with actual transfer-event data. */
function fixture(options: { genesis?: string; records?: ReturnType<typeof record>[]; denomination?: string; precision?: number; stateError?: Error; hash?: string; headerHash?: string } = {}) {
  const queriedAssets: unknown[] = [];
  const transfer = record('liquidityProxy', 'XorlessTransfer', [{ code: NATIVE_XOR_ASSET_ID }, payer, recipient, '1862198000000000000', '0x' + Buffer.from(reference).toString('hex')]);
  const records = options.records ?? [transfer, record('system', 'ExtrinsicSuccess', [])];
  const chainAt = { query: {
    system: { events: async () => records }, timestamp: { now: async () => codec(Date.parse('2026-09-25T00:00:00.000Z')) },
    denomination: { denominator: async () => codec(options.denomination ?? '1') },
    assets: { assetInfosV2: async (asset: unknown) => { queriedAssets.push(asset); return { ...codec({ precision: options.precision ?? 18 }), precision: codec(options.precision ?? 18) }; } },
  } };
  const api = {
    genesisHash: codec(options.genesis ?? genesis), disconnect: async () => {},
    at: async () => { if (options.stateError) throw options.stateError; return chainAt; },
    rpc: { chain: {
      getFinalizedHead: async () => codec(blockHash), getHeader: async () => ({ number: { toNumber: () => 100 } }),
      getBlockHash: async (number: number) => { assert.equal(number, 100); return codec(options.hash ?? blockHash); },
      getBlock: async () => ({ block: { header: { hash: codec(options.headerHash ?? options.hash ?? blockHash) }, extrinsics: [{ hash: codec(transactionHash), signer: codec(recipient) }, { hash: codec(`0x${'3'.repeat(64)}`) }] } }),
    } },
  } as unknown as ApiPromise;
  const config = { chain: { genesisHash: genesis, assetId: NATIVE_XOR_ASSET_ID, denomination: '1', decimals: 18, startBlock: 100 } } as MerchantConfig;
  return { api, config, reader: new SoraChainReader(api, config), queriedAssets, transfer };
}

/** Observe all durable mutations while testing unavailable or untrusted chain history. */
function scanStore() {
  let cursor = 100; let accepted = 0;
  const store = {
    cursor(next?: number) { if (next !== undefined) cursor = next; return cursor; },
    accept() { accepted++; },
  } as unknown as OrderStore;
  return { store, cursor: () => cursor, accepted: () => accepted };
}

test('reader extracts actual finalized native transfer amounts and caller from nonempty event data', async () => {
  const { reader } = fixture();
  const block = await reader.block(100);
  assert.equal(block.number, 100); assert.equal(block.transfers.length, 1);
  assert.deepEqual(block.transfers[0], {
    chainGenesisHash: genesis, assetId: NATIVE_XOR_ASSET_ID, payer, recipient,
    amountCodec: '1862198000000000000', reference, transactionHash, blockHash, blockNumber: '100', eventIndex: 0,
    successful: true, finalized: true, finalizedAt: '2026-09-25T00:00:00.000Z',
  });
  // The outer signer intentionally differs from the actual transfer caller (proxy/multisig).
  assert.equal(block.transfers[0]?.payer, payer);
  await reader.close();
});

test('reader refuses an unfinalized block, failed outer dispatch and mismatched success phase', async () => {
  const baseline = fixture();
  await assert.rejects(baseline.reader.block(101), /unfinalized/);
  const failed = fixture({ records: [baseline.transfer, record('system', 'ExtrinsicSuccess', []), record('system', 'ExtrinsicFailed', [])] });
  assert.equal((await failed.reader.block(100)).transfers.length, 0);
  const other = fixture({ records: [baseline.transfer, record('system', 'ExtrinsicSuccess', [], 1)] });
  assert.equal((await other.reader.block(100)).transfers.length, 0);
});

test('reader decodes only valid Option<Bytes> public references and ignores unrelated comments', async () => {
  for (const comment of [null, 'a customer address', '0x' + Buffer.from('private@email.example').toString('hex'), '0x' + Buffer.from(reference + 'extra').toString('hex')]) {
    const { reader } = fixture({ records: [record('liquidityProxy', 'XorlessTransfer', [NATIVE_XOR_ASSET_ID, payer, recipient, '1', comment]), record('system', 'ExtrinsicSuccess', [])] });
    assert.deepEqual((await reader.block(100)).transfers, []);
  }
});

test('configuration uses assetInfosV2 and pauses quotes on changed denomination or precision', async () => {
  const current = fixture(); await current.reader.assertConfiguration();
  assert.deepEqual(current.queriedAssets, [{ code: NATIVE_XOR_ASSET_ID }]);
  const redenominated = fixture({ denomination: '1000' });
  await assert.rejects(redenominated.reader.assertConfiguration(), /denomination|precision/);
  // Existing paid orders remain discoverable while new quotes are paused.
  assert.equal((await redenominated.reader.block(100)).transfers.length, 1);
  await assert.rejects(fixture({ precision: 17 }).reader.assertConfiguration(), /denomination|precision/);
});

test('wrong RPC genesis cannot advance the durable scan cursor', async () => {
  const { reader } = fixture({ genesis: `0x${'c'.repeat(64)}` });
  let cursor = 100; let mutations = 0;
  const store = {
    cursor(next?: number) { if (next !== undefined) { cursor = next; mutations++; } return cursor; },
    accept() { mutations++; throw new Error('Wrong chain must never reach acceptance'); },
  } as unknown as OrderStore;
  await assert.rejects(scanFinalized(store, reader), /genesis/);
  assert.equal(cursor, 100); assert.equal(mutations, 0);
});

test('pruned primary history requires an approved archive and preserves the scan cursor', async () => {
  const { reader } = fixture({ stateError: new Error('State already discarded for block') });
  const state = scanStore();
  await assert.rejects(scanFinalized(state.store, reader), (error: unknown) => error instanceof ArchiveRequiredError && error.code === 'archive_required');
  assert.equal(state.cursor(), 100); assert.equal(state.accepted(), 0);
});

test('approved archive restores event history pinned to the primary finalized block hash', async () => {
  const primary = fixture({ stateError: new Error('State already discarded for block') });
  const archive = fixture();
  const reader = new SoraChainReader(primary.api, primary.config, archive.api);
  const state = scanStore();
  const result = await scanFinalized(state.store, reader);
  assert.deepEqual(result, { caughtUp: true, processed: 1 });
  assert.equal(state.cursor(), 101); assert.equal(state.accepted(), 1);
  const block = await reader.block(100);
  assert.equal(block.transfers[0]?.blockHash, blockHash);
  assert.equal(block.transfers[0]?.payer, payer);
  await assert.rejects(reader.block(101), /unfinalized/);
});

test('wrong archive genesis or canonical hash cannot accept payments or advance the cursor', async () => {
  const primary = fixture({ stateError: new Error('State already discarded') });
  for (const options of [{ genesis: `0x${'c'.repeat(64)}` }, { hash: `0x${'d'.repeat(64)}` }, { headerHash: `0x${'e'.repeat(64)}` }]) {
    const archive = fixture(options);
    const state = scanStore();
    await assert.rejects(scanFinalized(state.store, new SoraChainReader(primary.api, primary.config, archive.api)), /genesis|hash mismatch/);
    assert.equal(state.cursor(), 100); assert.equal(state.accepted(), 0);
  }
});

test('unavailable archive history stays paused and unrelated RPC failures are never skipped', async () => {
  const primary = fixture({ stateError: new Error('State already discarded') });
  const archive = fixture({ stateError: new Error('UnknownBlock: State unavailable') });
  const state = scanStore();
  await assert.rejects(scanFinalized(state.store, new SoraChainReader(primary.api, primary.config, archive.api)), ArchiveRequiredError);
  assert.equal(state.cursor(), 100); assert.equal(state.accepted(), 0);
  const networkFailure = fixture({ stateError: new Error('connection closed') });
  await assert.rejects(scanFinalized(state.store, new SoraChainReader(networkFailure.api, networkFailure.config, fixture().api)), /connection closed/);
  assert.equal(state.cursor(), 100); assert.equal(state.accepted(), 0);
});
