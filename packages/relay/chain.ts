import { ApiPromise, WsProvider } from '@polkadot/api';
import { codecAmount, validatePaymentRequest, NATIVE_XOR_ASSET_ID, type PaymentRequest, type FinalizedTransferEvidence, type FinalizedNetworkFee } from '../core/index.js';
import { accountAddress, type MerchantConfig } from './config.js';
import type { OrderStore, RefundFeeQuote } from './store.js';
import { awaitWithAbort } from './lifecycle.js';

export interface FinalizedBlock { number: number; transfers: FinalizedTransferEvidence[] }
export interface ChainReader {
  head(): Promise<number>;
  block(number: number): Promise<FinalizedBlock>;
  assertConfiguration(): Promise<void>;
  quoteRefund(request: PaymentRequest, grossAmountCodec: string): Promise<RefundFeeQuote>;
  close(): Promise<void>;
}
interface Codec { toString(): string; toHex(): string; toJSON(): unknown }
interface EventRecord { phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber(): number } }; event: { section: string; method: string; data: ArrayLike<Codec> } }

/** Missing historical state pauses checkout without ever skipping unobserved payments. */
export class ArchiveRequiredError extends Error {
  readonly code = 'archive_required';
  constructor() { super('archive_required: finalized event history requires an approved archive RPC'); this.name = 'ArchiveRequiredError'; }
}

/** Classify pruning errors without exposing private RPC URLs or error payloads in logs. */
function missingHistoricalState(error: unknown): boolean {
  return error instanceof Error && /state (?:already )?discarded|state (?:is )?(?:not available|unavailable)|unknown\s*block|prun(?:ed|ing)|header not found|missing historical/i.test(error.message);
}

/** Current metadata is portable; only SORA's custom signed fee extension needs an override.
 * Definitions match Polkaswap src/lib/substrate/type-definitions/runtime.ts (Apache-2.0).
 */
export async function connectChain(config: MerchantConfig, signal?: AbortSignal): Promise<ChainReader> {
  const options = {
    noInitWarn: true,
    types: { AssetId: '[u8; 32]', Balance: 'u128', ChargeFeeInfo: { tip: 'Compact<Balance>', target_asset_id: 'AssetId' } },
    signedExtensions: { ChargeTransactionPayment2: { extrinsic: { charge_fee_info: 'ChargeFeeInfo' }, payload: {} } },
  };
  const create = async (url: string): Promise<ApiPromise> => {
    signal?.throwIfAborted();
    const provider = new WsProvider(url);
    const pending = ApiPromise.create({ ...options, provider });
    try { return await awaitWithAbort(pending, signal); }
    catch (error) {
      await provider.disconnect();
      void pending.then((lateApi) => lateApi.disconnect(), () => undefined).catch(() => undefined);
      throw error;
    }
  };
  const api = await create(config.chain.rpcUrl);
  let archive: ApiPromise | undefined;
  try {
    if (config.chain.archiveRpcUrl) archive = await create(config.chain.archiveRpcUrl);
    signal?.throwIfAborted();
    return new SoraChainReader(api, config, archive);
  } catch (error) { await api.disconnect(); await archive?.disconnect(); throw error; }
}

/** Read finalized chain state only. Browser hashes have no authority in this adapter. */
export class SoraChainReader implements ChainReader {
  constructor(private api: ApiPromise, private config: MerchantConfig, private archive?: ApiPromise, private now: () => number = Date.now) {}
  async close(): Promise<void> { await this.api.disconnect(); await this.archive?.disconnect(); }
  async head(): Promise<number> { if (this.api.genesisHash.toHex().toLowerCase() !== this.config.chain.genesisHash) throw new Error('RPC genesis mismatch'); const hash = await this.api.rpc.chain.getFinalizedHead(); return (await this.api.rpc.chain.getHeader(hash)).number.toNumber(); }
  async assertConfiguration(): Promise<void> {
    if (this.api.genesisHash.toHex().toLowerCase() !== this.config.chain.genesisHash) throw new Error('RPC genesis mismatch');
    const hash = await this.api.rpc.chain.getFinalizedHead(); const at = await this.api.at(hash);
    const denominatorQuery = at.query.denomination?.denominator;
    const assetQuery = at.query.assets?.assetInfosV2;
    if (!denominatorQuery || !assetQuery) throw new Error('Required SORA metadata unavailable');
    const [denomination, asset] = await Promise.all([denominatorQuery(), assetQuery({ code: this.config.chain.assetId })]);
    const details = asset.toJSON() as { precision?: number };
    if (denomination.toString() !== this.config.chain.denomination || typeof details !== 'object' || Number(details.precision) !== this.config.chain.decimals) throw new Error('Chain denomination or precision changed: checkout paused');
  }
  /** Estimate the exact native transfer at finalized state, using a dummy signature only for encoded length.
   * The RPC receives no signing key or valid signature, and this method never submits an extrinsic.
   * A mortal sr25519 envelope and zero tip match the supported wallet path; finalized fee evidence
   * remains authoritative if nonce, signature type or runtime state changes before inclusion.
   */
  async quoteRefund(request: PaymentRequest, grossAmountCodec: string): Promise<RefundFeeQuote> {
    validatePaymentRequest(request);
    const gross = codecAmount(grossAmountCodec, false);
    if (request.amountCodec !== grossAmountCodec || request.chainGenesisHash !== this.config.chain.genesisHash || request.assetId !== NATIVE_XOR_ASSET_ID || request.assetId !== this.config.chain.assetId || accountAddress(request.payer) !== this.config.chain.recipient || request.decimals !== this.config.chain.decimals || request.denomination !== this.config.chain.denomination || Date.parse(request.expiresAt) <= this.now()) throw new Error('Refund request configuration mismatch');
    await this.assertConfiguration();
    const hash = await this.api.rpc.chain.getFinalizedHead();
    const [at, header, runtimeVersion] = await Promise.all([this.api.at(hash), this.api.rpc.chain.getHeader(hash), this.api.rpc.state.getRuntimeVersion(hash)]);
    if (runtimeVersion.specVersion.toString() !== this.api.runtimeVersion.specVersion.toString() || runtimeVersion.transactionVersion.toString() !== this.api.runtimeVersion.transactionVersion.toString()) throw new Error('Refund runtime changed');
    const extensions = at.registry.signedExtensions;
    if (!extensions.includes('ChargeTransactionPayment') || extensions.includes('ChargeTransactionPayment2')) throw new Error('Unsupported refund fee extension');
    const build = this.api.tx.liquidityProxy?.xorlessTransfer;
    const queryInfo = at.call.transactionPaymentApi?.queryInfo;
    if (!build || !queryInfo || !at.query.system?.account) throw new Error('Refund fee metadata unavailable');
    const account = await at.query.system.account(request.payer);
    const nonce = (account.toJSON() as { nonce?: unknown }).nonce;
    if (!(typeof nonce === 'number' && Number.isSafeInteger(nonce) && nonce >= 0) && !(typeof nonce === 'string' && /^(?:0|[1-9][0-9]*|0x[0-9a-f]+)$/.test(nonce))) throw new Error('Refund nonce unavailable');
    let amount = gross;
    for (let attempt = 0; attempt < 4; attempt++) {
      const call = build(0, { code: NATIVE_XOR_ASSET_ID }, request.recipient, amount.toString(), '0', '0', [], 'Disabled', `0x${Buffer.from(request.reference, 'utf8').toString('hex')}`);
      const simulated = at.tx(call.toU8a());
      simulated.signFake(request.payer, { blockHash: hash, genesisHash: this.api.genesisHash, runtimeVersion, nonce, tip: 0, era: at.registry.createType('ExtrinsicEra', { current: header.number, period: 64 }) });
      const bytes = simulated.toU8a();
      const info = await queryInfo(bytes, bytes.length);
      const feeValue = (info as unknown as { partialFee?: Codec }).partialFee;
      if (!feeValue) throw new Error('Refund fee unavailable');
      const fee = codecAmount(feeValue.toString(), false);
      if (fee >= gross) throw new Error('Refund amount does not cover its network fee');
      const net = gross - fee;
      if (net === amount) return { amountCodec: net.toString(), feeCodec: fee.toString(), blockHash: hash.toHex().toLowerCase(), blockNumber: header.number.toString(), expiresAt: new Date(this.now() + 120_000).toISOString() };
      amount = net;
    }
    throw new Error('Refund fee did not converge');
  }
  async block(number: number): Promise<FinalizedBlock> {
    if (number > await this.head()) throw new Error('Cannot read unfinalized block');
    const hash = await this.api.rpc.chain.getBlockHash(number);
    try { return await this.readBlock(this.api, number, hash.toHex()); }
    catch (error) {
      if (!missingHistoricalState(error)) throw error;
      if (!this.archive) throw new ArchiveRequiredError();
      if (this.archive.genesisHash.toHex().toLowerCase() !== this.config.chain.genesisHash) throw new Error('Archive RPC genesis mismatch');
      const archiveHash = await this.archive.rpc.chain.getBlockHash(number);
      if (archiveHash.toHex().toLowerCase() !== hash.toHex().toLowerCase()) throw new Error('Archive RPC finalized block hash mismatch');
      try { return await this.readBlock(this.archive, number, hash.toHex()); }
      catch (archiveError) { if (missingHistoricalState(archiveError)) throw new ArchiveRequiredError(); throw archiveError; }
    }
  }

  /** Decode events from a trusted source pinned to the primary RPC's finalized canonical block. */
  private async readBlock(source: ApiPromise, number: number, hash: string): Promise<FinalizedBlock> {
    const [block, at] = await Promise.all([source.rpc.chain.getBlock(hash), source.at(hash)]);
    if (block.block.header.hash.toHex().toLowerCase() !== hash.toLowerCase()) throw new Error('RPC block header hash mismatch');
    if (!at.query.system?.events || !at.query.timestamp?.now) throw new Error('Block metadata unavailable');
    const [recordsCodec, timestamp] = await Promise.all([at.query.system.events(), at.query.timestamp.now()]);
    const records = Array.from(recordsCodec as unknown as Iterable<EventRecord>);
    const finalizedAt = new Date(Number(timestamp.toString())).toISOString();
    const transfers: FinalizedTransferEvidence[] = [];
    for (const [eventIndex, record] of records.entries()) {
      if (!record.phase.isApplyExtrinsic || record.event.section !== 'liquidityProxy' || record.event.method !== 'XorlessTransfer') continue;
      const extrinsicIndex = record.phase.asApplyExtrinsic.toNumber();
      const related = records.filter((r) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === extrinsicIndex);
      if (!related.some((r) => r.event.section === 'system' && r.event.method === 'ExtrinsicSuccess') || related.some((r) => r.event.section === 'system' && r.event.method === 'ExtrinsicFailed')) continue;
      const extrinsic = block.block.extrinsics[extrinsicIndex];
      const data = record.event.data;
      if (!extrinsic || data.length !== 5) throw new Error('Unrecognized SORA transfer event');
      const additionalData = data[4]!.toJSON();
      if (typeof additionalData !== 'string' || !/^0x[0-9a-fA-F]*$/.test(additionalData)) continue;
      const reference = Buffer.from(additionalData.slice(2), 'hex').toString('utf8');
      if (!/^sp_[a-f0-9]{32}$/.test(reference)) continue;
      // The event reports the actual caller, receiver and transferred amount, including nested calls.
      // An outer multisig/proxy signer is intentionally not mistaken for the payer.
      const assetJson = data[0]!.toJSON();
      const assetId = typeof assetJson === 'string' ? assetJson : (assetJson as { code?: string })?.code;
      if (typeof assetId !== 'string') throw new Error('Unrecognized asset identifier');
      const payer = accountAddress(data[1]!.toString());
      const networkFee = finalizedNetworkFee(records, extrinsicIndex, extrinsic, payer, assetId.toLowerCase());
      transfers.push({ ...(networkFee ? { networkFee } : {}), chainGenesisHash: this.config.chain.genesisHash, assetId: assetId.toLowerCase(), payer: accountAddress(data[1]!.toString()), recipient: accountAddress(data[2]!.toString()), amountCodec: data[3]!.toString(), reference, transactionHash: extrinsic.hash.toHex(), blockHash: hash, blockNumber: String(number), eventIndex, successful: true, finalized: true, finalizedAt });
    }
    return { number, transfers };
  }
}

/** Corroborate SORA's withdrawal with TransactionFeePaid; these describe ONE fee, never two.
 * Unknown event layouts, tips, nested calls and multiple transfers do not establish a deductible fee.
 */
function finalizedNetworkFee(records: EventRecord[], extrinsicIndex: number, extrinsic: { isSigned: boolean; signer: { toString(): string }; method: { section: string; method: string } }, payer: string, assetId: string): FinalizedNetworkFee | undefined {
  try {
    if (assetId !== NATIVE_XOR_ASSET_ID || !extrinsic.isSigned || extrinsic.method.section !== 'liquidityProxy' || extrinsic.method.method !== 'xorlessTransfer' || accountAddress(extrinsic.signer.toString()) !== payer) return undefined;
    const related = records.map((record, index) => ({ record, index })).filter(({ record }) => record.phase.isApplyExtrinsic && record.phase.asApplyExtrinsic.toNumber() === extrinsicIndex);
    if (related.filter(({ record: { event } }) => event.section === 'liquidityProxy' && event.method === 'XorlessTransfer').length !== 1) return undefined;
    const withdrawals = related.filter(({ record: { event } }) => event.section === 'xorFee' && event.method === 'FeeWithdrawn');
    const paidEvents = related.filter(({ record: { event } }) => event.section === 'transactionPayment' && event.method === 'TransactionFeePaid');
    if (withdrawals.length !== 1 || paidEvents.length !== 1) return undefined;
    const withdrawal = withdrawals[0]!; const feeData = withdrawal.record.event.data; const paid = paidEvents[0]!.record.event.data;
    // Mainnet spec131's FeeWithdrawn is (AccountId, Balance); other layouts need explicit review.
    if (feeData.length !== 2 || paid.length !== 3 || accountAddress(feeData[0]!.toString()) !== payer || accountAddress(paid[0]!.toString()) !== payer || paid[2]!.toString() !== '0') return undefined;
    const amount = codecAmount(feeData[1]!.toString());
    if (amount !== codecAmount(paid[1]!.toString())) return undefined;
    return { payer, assetId, amountCodec: amount.toString(), eventIndex: withdrawal.index };
  } catch { return undefined; }
}

/** Catch up in bounded batches; committing after events makes crash replays idempotent. */
export async function scanFinalized(store: OrderStore, chain: ChainReader, limit = 100, signal?: AbortSignal): Promise<{ caughtUp: boolean; processed: number }> {
  signal?.throwIfAborted();
  const head = await awaitWithAbort(chain.head(), signal); let cursor = store.cursor(); let processed = 0;
  while (cursor <= head && processed < limit) {
    const block = await awaitWithAbort(chain.block(cursor), signal);
    signal?.throwIfAborted();
    if (block.number !== cursor) throw new Error('Unexpected block response');
    for (const transfer of block.transfers) store.accept(transfer);
    store.cursor(++cursor); processed++;
  }
  return { caughtUp: cursor > head, processed };
}
