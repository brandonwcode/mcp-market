// Money is US dollars, stored as integer micro-dollars (1 USD = 1,000,000), the same 6 decimals as
// USDC and USDT on Solana, so a deposit is credited to the last unit and never rounded.
export const MICRO = 1_000_000;

export class MoneyError extends Error {}

// "$1,234.50", "$0.24975": always at least cents, more digits only when they are not zero
export function usd(micro) {
  const n = BigInt(micro);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const dollars = (a / 1_000_000n).toLocaleString('en-US');
  let frac = String(a % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}$${dollars}.${frac}`;
}

// micro-dollars to a plain dollar number for JSON (exact up to $9 billion)
export const dollars = (micro) => (micro == null ? null : Number(micro) / MICRO);

// a dollar amount typed by a person or an AI (12, 12.5, "12.50") to micro-dollars.
// `decimals` caps the precision: prices are whole cents, withdrawals may go down to the micro-dollar.
export function toMicro(value, { decimals = 2, what = 'Amount' } = {}) {
  const num = typeof value === 'string' ? Number(value.trim().replace(/^\$/, '')) : value;
  if (typeof num !== 'number' || !Number.isFinite(num) || num <= 0) throw new MoneyError(`${what} must be a dollar amount above zero.`);
  const fixed = num.toFixed(decimals);
  if (Math.abs(Number(fixed) - num) > 1e-9) {
    throw new MoneyError(decimals === 2 ? `${what} must be in whole cents, like 12.50.` : `${what} has too many decimal places.`);
  }
  const [whole, frac = ''] = fixed.split('.');
  const micro = BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
  if (micro <= 0n) throw new MoneyError(`${what} must be a dollar amount above zero.`);
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError(`${what} is too large.`);
  return Number(micro);
}

// an on-chain token amount (raw integer string, `decimals` places) to micro-dollars, rounding down
export function tokenToMicro(raw, decimals) {
  const n = BigInt(raw);
  if (decimals === 6) return n;
  return decimals < 6 ? n * 10n ** BigInt(6 - decimals) : n / 10n ** BigInt(decimals - 6);
}
