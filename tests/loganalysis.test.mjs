import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commonTraits, commonTraitsText, groupByTurn } from '../js/loganalysis.js';

// Minimal character stubs using the real trait keys
// (hair, style, eye, skin, glasses, hat, beard, acc).
const mk = (o) => ({
  hair: 'black', style: 'short', eye: 'brown', skin: 'light',
  glasses: 'none', hat: 'none', beard: 'none', acc: 'none', ...o,
});

test('commonTraits: shared values across all cards are returned', () => {
  const cards = [
    mk({ glasses: 'sun', hair: 'black' }),
    mk({ glasses: 'sun', hair: 'blonde' }),   // hair differs
    mk({ glasses: 'sun', hair: 'red' }),
  ];
  const shared = commonTraits(cards);
  const keys = shared.map((t) => t.trait);
  assert.ok(keys.includes('glasses'), 'glasses is shared (all sun)');
  assert.ok(!keys.includes('hair'), 'hair is NOT shared');
  const g = shared.find((t) => t.trait === 'glasses');
  assert.equal(g.value, 'sun');
  assert.equal(g.label, 'Glasses');
  assert.equal(g.valueLabel, 'Sunglasses');
});

test('commonTraits: empty batch -> [] ', () => {
  assert.deepEqual(commonTraits([]), []);
  assert.deepEqual(commonTraits(null), []);
});

test('commonTraits: a single card shares all of its own traits', () => {
  const shared = commonTraits([mk({ glasses: 'round' })]);
  // Every trait key present -> 8 shared traits.
  assert.equal(shared.length, 8);
  assert.equal(shared.find((t) => t.trait === 'glasses').valueLabel, 'Round');
});

test('commonTraits: nothing shared when cards fully differ on a trait', () => {
  const cards = [mk({ eye: 'brown' }), mk({ eye: 'blue' })];
  assert.ok(!commonTraits(cards).some((t) => t.trait === 'eye'));
});

test('commonTraitsText: readable summary and empty case', () => {
  const txt = commonTraitsText([mk({ glasses: 'sun', hat: 'crown' }), mk({ glasses: 'sun', hat: 'crown', hair: 'red' })]);
  assert.match(txt, /Glasses = Sunglasses/);
  assert.match(txt, /Headwear = Crown/);
  // A batch with no shared trait at all:
  const none = commonTraitsText([
    mk({ hair: 'black', style: 'short', eye: 'brown', skin: 'light', glasses: 'none', hat: 'none', beard: 'none', acc: 'none' }),
    mk({ hair: 'red', style: 'long', eye: 'blue', skin: 'deep', glasses: 'sun', hat: 'crown', beard: 'beard', acc: 'scarf' }),
  ]);
  assert.equal(none, 'no shared traits');
});

test('groupByTurn: buckets events by turn in order', () => {
  const evs = [
    { turn: 1, kind: 'chat' }, { turn: 1, kind: 'card' },
    { turn: 2, kind: 'ask' }, { turn: 1, kind: 'card' },
    { turn: 3, kind: 'guess' },
  ];
  const groups = groupByTurn(evs);
  assert.deepEqual(groups.map((g) => g.turn), [1, 2, 3]);
  assert.equal(groups[0].events.length, 3);   // three turn-1 events preserved
  assert.equal(groups[1].events.length, 1);
});
