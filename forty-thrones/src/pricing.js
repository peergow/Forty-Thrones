// All money is integer US cents. Never use floating point for prices.

/** ceil(last * 1.1) using integer math. */
export function minIncrease(lastCents) {
  return Math.floor((lastCents * 11 + 9) / 10);
}

/** Minimum price to seize a tile. First purchase uses the floor price. */
export function nextPriceCents(lastCents, floorCents) {
  if (!lastCents || lastCents <= 0) return floorCents;
  return Math.max(floorCents, minIncrease(lastCents));
}

export function formatUsd(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
