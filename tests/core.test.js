import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, diffDays, dayRange, toDay } from '../js/dates.js';
import {
  DEFAULT_GAMES,
  activeGames,
  findEntry,
  formatScore,
  hasScore,
  merge,
  removeEntry,
  sameData,
  setEntry,
  upsertGame,
  withDefaults,
  emptyData,
} from '../js/model.js';
import { gameStats, overallStats } from '../js/stats.js';

const at = (iso) => new Date(iso);

test('dates: addDays/diffDays across month, year and DST boundaries', () => {
  assert.equal(addDays('2026-11-21', 1), '2026-11-22');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(addDays('2024-06-23', 881), '2026-11-21');
  assert.equal(diffDays('2026-11-01', '2026-10-31'), 1);
  assert.deepEqual(dayRange('2026-01-02', 3), ['2025-12-31', '2026-01-01', '2026-01-02']);
  assert.equal(toDay(new Date(2026, 10, 21, 23, 59)), '2026-11-21');
});

test('model: defaults are seeded once and are archivable', () => {
  const d = withDefaults(emptyData());
  assert.deepEqual(d.games.map((g) => g.id), ['catfishing', 'farflung', 'leetcode']);
  const archived = upsertGame(d, { ...d.games[0], archived: true });
  assert.deepEqual(activeGames(withDefaults(archived)).map((g) => g.id), ['farflung', 'leetcode']);
  assert.equal(hasScore(d.games.find((g) => g.id === 'leetcode')), false);
  assert.equal(hasScore(d.games[0]), true);
});

test('model: merge keeps newest version per entry and honours tombstones', () => {
  let a = setEntry(emptyData(), { gameId: 'x', day: '2026-11-20', score: 1 }, at('2026-11-20T10:00:00Z'));
  let b = setEntry(emptyData(), { gameId: 'x', day: '2026-11-20', score: 5 }, at('2026-11-20T11:00:00Z'));
  b = setEntry(b, { gameId: 'x', day: '2026-11-21', score: 2 }, at('2026-11-21T09:00:00Z'));
  const m = merge(a, b);
  assert.equal(findEntry(m, 'x', '2026-11-20').score, 5);
  assert.equal(findEntry(m, 'x', '2026-11-21').score, 2);

  a = removeEntry(m, 'x', '2026-11-21', at('2026-11-21T12:00:00Z'));
  const m2 = merge(b, a);
  assert.equal(findEntry(m2, 'x', '2026-11-21'), null);
  assert.ok(sameData(merge(m2, m2), m2));
  assert.ok(sameData(merge(a, b), merge(b, a)), 'merge is order-independent');
});

test('model: seeded games lose to any synced edit', () => {
  const remote = upsertGame(emptyData(), { ...DEFAULT_GAMES[0], name: 'Catfishing!' }, at('2026-11-21T00:00:00Z'));
  const m = merge(withDefaults(emptyData()), remote);
  assert.equal(m.games.find((g) => g.id === 'catfishing').name, 'Catfishing!');
});

test('model: upsertGame creates unique ids and appends order', () => {
  let d = withDefaults(emptyData());
  d = upsertGame(d, { name: 'Far Flung', url: 'https://x.test' });
  d = upsertGame(d, { name: 'Far Flung', url: 'https://y.test' });
  const ids = d.games.map((g) => g.id);
  assert.ok(ids.includes('far-flung') && ids.includes('far-flung-2'));
  assert.equal(d.games.at(-1).order, 4);
});

test('model: tombstone wins a timestamp tie; slow clocks still overwrite', () => {
  const ts = at('2026-11-21T10:00:00Z');
  const live = setEntry(emptyData(), { gameId: 'x', day: '2026-11-21', score: 1 }, ts);
  const dead = removeEntry(emptyData(), 'x', '2026-11-21', ts);
  assert.equal(findEntry(merge(live, dead), 'x', '2026-11-21'), null);
  assert.equal(findEntry(merge(dead, live), 'x', '2026-11-21'), null);

  const future = setEntry(emptyData(), { gameId: 'x', day: '2026-11-20', score: 1 }, at('2030-01-01T00:00:00Z'));
  const edited = setEntry(future, { gameId: 'x', day: '2026-11-20', score: 2 }, at('2026-11-21T00:00:00Z'));
  assert.equal(findEntry(merge(future, edited), 'x', '2026-11-20').score, 2);
  const cleared = removeEntry(future, 'x', '2026-11-20', at('2026-11-21T00:00:00Z'));
  assert.equal(findEntry(merge(future, cleared), 'x', '2026-11-20'), null);
});

test('model: invalid remote records are dropped', () => {
  const bad = {
    games: [{ id: 5 }, { id: 'ok', updatedAt: 'nope' }, { id: 'good' }],
    entries: [
      { gameId: 'g', day: 20261121 },
      { gameId: 'g', day: '2026-11-21"><img src=x>' },
      { gameId: 'g', day: '2026-11-21', score: 'x' },
      { gameId: 'g', day: '2026-11-21', score: 3 },
    ],
  };
  const n = merge(bad, {});
  assert.deepEqual(n.games.map((g) => g.id), ['good']);
  assert.equal(n.entries.length, 1);
});

test('stats: future-dated entries are ignored until their day', () => {
  let d = setEntry(emptyData(), { gameId: 'g', day: '2026-11-22', score: 10 });
  d = setEntry(d, { gameId: 'g', day: '2026-11-21', score: 2 });
  const s = gameStats(d, 'g', '2026-11-21');
  assert.deepEqual([s.total, s.best, s.longest], [1, 2, 1]);
});

test('model: formatScore', () => {
  assert.equal(formatScore({ score: { max: 10 } }, { score: 3 }), '3/10');
  assert.equal(formatScore({ score: { label: 'pts' } }, { score: 320 }), '320 pts');
  assert.equal(formatScore({ score: { label: 'pts' } }, { score: null }), '');
  assert.equal(formatScore({ score: { max: 10 } }, { score: 0 }), '0/10');
});

test('stats: current streak, at-risk, longest, totals', () => {
  let d = emptyData();
  for (const day of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-18', '2026-11-19', '2026-11-20']) {
    d = setEntry(d, { gameId: 'g', day, score: 4 });
  }
  let s = gameStats(d, 'g', '2026-11-21');
  assert.equal(s.current, 3);
  assert.equal(s.atRisk, true);
  assert.equal(s.longest, 3);
  assert.equal(s.total, 6);
  assert.equal(s.average, 4);

  d = setEntry(d, { gameId: 'g', day: '2026-11-21', score: 10 });
  s = gameStats(d, 'g', '2026-11-21');
  assert.deepEqual([s.current, s.atRisk, s.longest, s.best], [4, false, 4, 10]);

  s = gameStats(d, 'g', '2026-11-23');
  assert.deepEqual([s.current, s.atRisk], [0, false]);
});

test('stats: all-dailies streak requires every active game', () => {
  let d = withDefaults(emptyData());
  for (const day of ['2026-11-19', '2026-11-20', '2026-11-21']) d = setEntry(d, { gameId: 'catfishing', day });
  for (const day of ['2026-11-20', '2026-11-21']) d = setEntry(d, { gameId: 'farflung', day });
  const o = overallStats(d, '2026-11-21');
  assert.deepEqual([o.allCurrent, o.allLongest, o.doneToday, o.gameCount, o.daysPlayed], [2, 2, 2, 3, 3]);
});

test('stats: LeetCode (no score) counts toward the all-dailies streak from the day it was added', () => {
  let d = withDefaults(emptyData());
  for (const day of ['2026-11-22', '2026-11-23', '2026-11-24']) {
    d = setEntry(d, { gameId: 'catfishing', day, score: 5 });
    d = setEntry(d, { gameId: 'farflung', day, score: 300 });
  }
  let o = overallStats(d, '2026-11-24');
  assert.equal(o.allCurrent, 2, 'today needs LeetCode too');
  assert.equal(o.allAtRisk, true);
  d = setEntry(d, { gameId: 'leetcode', day: '2026-11-24' });
  o = overallStats(d, '2026-11-24');
  assert.deepEqual([o.allCurrent, o.allAtRisk], [3, false]);
  assert.equal(findEntry(d, 'leetcode', '2026-11-24').score, null);
  assert.equal(gameStats(d, 'leetcode', '2026-11-24').current, 1);
});

test('stats: adding a game does not reset the all-dailies streak', () => {
  let d = withDefaults(emptyData());
  for (const day of ['2026-11-19', '2026-11-20']) {
    d = setEntry(d, { gameId: 'catfishing', day });
    d = setEntry(d, { gameId: 'farflung', day });
  }
  d = upsertGame(d, { name: 'New', url: 'https://x.test' }, at('2026-11-21T08:00:00'));
  assert.equal(d.games.find((g) => g.id === 'new').addedOn, '2026-11-21');
  let o = overallStats(d, '2026-11-21');
  assert.deepEqual([o.allCurrent, o.allAtRisk], [2, true]);
  for (const id of ['catfishing', 'farflung']) d = setEntry(d, { gameId: id, day: '2026-11-21' });
  assert.equal(overallStats(d, '2026-11-21').allCurrent, 2, 'new game still required today');
  d = setEntry(d, { gameId: 'new', day: '2026-11-21' });
  assert.equal(overallStats(d, '2026-11-21').allCurrent, 3);
});
