/** Exact decimal ratio without JavaScript floating-point token arithmetic. */
function ratio(value: string): [bigint, bigint] {
  if (!/^\d+(?:\.\d{1,18})?$/.test(value) || value.length > 60) throw new Error('Invalid decimal');
  const [whole, part = ''] = value.split('.');
  return [BigInt(whole + part), 10n ** BigInt(part.length)];
}

/** Freeze merchant JPY reference prices at $5.37/XOR, rounded upward to six places. */
export function xorPriceFromJpy(jpy: string, jpyPerUsd: string, usdPerXor = '5.37'): string {
  const [yen, yenScale] = ratio(jpy);
  const [fx, fxScale] = ratio(jpyPerUsd);
  const [credit, creditScale] = ratio(usdPerXor);
  if (credit <= 0n) throw new Error('USD per XOR must be positive');
  if (fx <= 0n) throw new Error('JPY per USD must be positive');
  const numerator = yen * fxScale * creditScale * 1_000_000n;
  const denominator = yenScale * fx * credit;
  const micro = (numerator + denominator - 1n) / denominator;
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0')}`;
}

/** Convert display XOR to chain codec units while checking the chain denomination snapshot. */
export function xorToCodec(xor: string, decimals: number, denomination: string): string {
  const [value, scale] = ratio(xor);
  if (!/^[1-9]\d*$/.test(denomination)) throw new Error('Invalid denomination snapshot');
  const numerator = value * 10n ** BigInt(decimals);
  if (numerator % scale !== 0n) throw new Error('Price cannot be represented exactly');
  const codec = numerator / scale;
  if (codec > (1n << 128n) - 1n) throw new Error('Amount exceeds u128');
  return codec.toString();
}
