import { NATIVE_XOR_ASSET_ID } from '../../dist/core/index.js';
import type { FinalizedTransferEvidence, PaymentRequest, WalletState } from '../../dist/core/index.js';

/** Offline test identities; no private keys or real chain connections are used. */
export const request: PaymentRequest = {
  version: 1, merchant: { id: 'store', name: 'Community store' }, chainGenesisHash: `0x${'a'.repeat(64)}`,
  assetId: NATIVE_XOR_ASSET_ID, recipient: 'cnRsfMpGQ24tCKDLBbwde6NrS9ttrXN3hjX3zMHnVDeQokoBA', payer: 'cnSG3F5hh3Z5JzV2Qzn6Ez71CL8NUTi68wr9zrjdNedrJht1C',
  amountCodec: '1862198000000000000', decimals: 18, denomination: '1',
  reference: `sp_${'b'.repeat(32)}`, expiresAt: '2030-01-01T00:30:00.000Z',
};
export const state: WalletState = {
  account: request.payer, chainGenesisHash: request.chainGenesisHash, assetId: request.assetId,
  decimals: request.decimals, denomination: '1', balanceCodec: '2000000000000000000',
};
export const evidence: FinalizedTransferEvidence = {
  ...request, transactionHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`,
  blockNumber: '123', eventIndex: 4, successful: true, finalized: true, finalizedAt: '2030-01-01T00:01:00.000Z',
};
