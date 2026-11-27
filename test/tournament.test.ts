import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowedAdd,
  botOf,
  botPoints,
  MAX_ADD,
  MAX_POINTS,
  MIN_GAP_MS,
  nextWindow,
  parseSlots,
  prizeFor,
  rank,
  scheduleFromEnv,
  shadowGroupOf,
  windowAt,
  windowOfId,
} from '../src/services/tournamentRules';

const s = scheduleFromEnv({ TOURNAMENT_SLOTS_UTC: '10:00,16:00,19:00', TOURNAMENT_MINUTES: '30' } as NodeJS.ProcessEnv);
const at = (iso: string) => Date.parse(iso);

test('parseSlots: sorted minutes, bad parts left out', () => {
  assert.deepEqual(parseSlots('19:00, 10:00,bad,25:00,16:30'), [600, 990, 1140]);
});

test('windowAt: open inside a slot, closed outside', () => {
  const w = windowAt(at('2026-11-25T10:12:00Z'), s)!;
  assert.equal(w.id, '2026-11-25T10:00Z');
  assert.equal(w.endsAt - w.startsAt, 30 * 60_000);
  assert.equal(windowAt(at('2026-11-25T10:30:00Z'), s), null);
  assert.equal(windowAt(at('2026-11-25T12:00:00Z'), s), null);
});

test('nextWindow: later today, else tomorrow', () => {
  assert.equal(nextWindow(at('2026-11-25T12:00:00Z'), s).id, '2026-11-25T16:00Z');
  assert.equal(nextWindow(at('2026-11-25T20:00:00Z'), s).id, '2026-11-26T10:00Z');
});

test('always: a window every half hour', () => {
  const a = scheduleFromEnv({ TOURNAMENT_ALWAYS: '1' } as NodeJS.ProcessEnv);
  assert.equal(windowAt(at('2026-11-25T03:47:00Z'), a)!.id, '2026-11-25T03:30Z');
});

test('windowOfId: round trip', () => {
  const w = windowOfId('2026-11-25T16:00Z', s)!;
  assert.equal(w.startsAt, at('2026-11-25T16:00:00Z'));
  assert.equal(windowOfId('nonsense', s), null);
});

test('bots: the same for everyone, points only grow and stop at the end', () => {
  const w = windowAt(at('2026-11-25T10:05:00Z'), s)!;
  assert.deepEqual(botOf(w.id, 3, 1), botOf(w.id, 3, 1));
  const b = botOf(w.id, 0, 0);
  let last = -1;
  for (let m = 0; m <= 40; m += 2) {
    const p = botPoints(b, w, w.startsAt + m * 60_000);
    assert.ok(p >= last);
    last = p;
  }
  assert.equal(botPoints(b, w, w.endsAt + 600_000), botPoints(b, w, w.endsAt));
  // Beatable: a bot never gets near what an active player can.
  assert.ok(botPoints(b, w, w.endsAt) < 1600);
});

test('rank: points, then who joined first', () => {
  const r = rank([
    { id: 'a', name: 'a', avatar: 'leo', frame: 'gold', points: 10, joinedAt: 5, bot: false },
    { id: 'b', name: 'b', avatar: 'leo', frame: 'gold', points: 30, joinedAt: 9, bot: true },
    { id: 'c', name: 'c', avatar: 'leo', frame: 'gold', points: 10, joinedAt: 1, bot: false },
  ]);
  assert.deepEqual(r.map((x) => [x.id, x.rank]), [['b', 1], ['c', 2], ['a', 3]]);
});

test('allowedAdd: caps, gaps and the most in all', () => {
  assert.equal(allowedAdd(0, 0, 80, 1000), 80);
  assert.equal(allowedAdd(0, 0, 99999, 1000), MAX_ADD);
  assert.equal(allowedAdd(0, 1000, 50, 1000 + MIN_GAP_MS - 1), null);
  assert.equal(allowedAdd(MAX_POINTS - 5, 0, 50, 1000), 5);
  assert.equal(allowedAdd(0, 0, 0, 1000), null);
});

test('prizeFor: the first only', () => {
  assert.ok(prizeFor(1)!.length >= 1);
  assert.equal(prizeFor(2), null);
  assert.equal(prizeFor(4), null);
  assert.equal(prizeFor(0), null);
});

test('shadowGroupOf: always negative, deterministic, never collides with real groups, bots work cleanly', () => {
  const w = windowAt(at('2026-11-25T10:05:00Z'), s)!;
  const g1 = shadowGroupOf(w.id, 'p_cheater_1');
  const g2 = shadowGroupOf(w.id, 'p_cheater_2');
  assert.ok(g1 < 0 && Number.isInteger(g1));
  assert.ok(g2 < 0 && Number.isInteger(g2));
  assert.equal(g1, shadowGroupOf(w.id, 'p_cheater_1'));
  assert.notEqual(g1, g2);
  // Bots in negative shadow groups generate valid deterministic scores.
  const b = botOf(w.id, g1, 0);
  assert.ok(b.name.length > 0 && b.pace >= 95);
  assert.ok(botPoints(b, w, w.endsAt) > 0);
});
