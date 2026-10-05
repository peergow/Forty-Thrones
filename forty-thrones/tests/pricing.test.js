import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPriceCents, minIncrease } from '../src/pricing.js';

test('first purchase uses the floor price', () => {
  assert.equal(nextPriceCents(0, 100), 100);
});
test('each seizure costs at least 10% more, rounded up', () => {
  assert.equal(minIncrease(100), 110);
  assert.equal(minIncrease(101), 112);   // 111.1 -> 112
  assert.equal(minIncrease(110), 121);
  assert.equal(minIncrease(1), 2);
});
test('matches the proposal table: 20 seizures from $1 total about $57', () => {
  let price = 0, total = 0;
  for (let i = 0; i < 20; i++) { price = nextPriceCents(price, 100); total += price; }
  assert.ok(total / 100 > 55 && total / 100 < 65, `total was ${total / 100}`);
});
