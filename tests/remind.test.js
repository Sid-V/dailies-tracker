import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReminder, localParts, sendNtfy, slotFor } from '../reminders/remind.js';
import { emptyData, setEntry, withDefaults } from '../js/model.js';

const tz = 'America/Los_Angeles';
const morning = new Date('2026-11-21T16:30:00Z'); // 8:30 AM PST
const evening = new Date('2026-11-22T04:30:00Z'); // 8:30 PM PST on Nov 21
const AM = '30 8 * * *';
const PM = '30 20 * * *';

test('remind: local day/hour follow the reminder timezone, including DST', () => {
  assert.deepEqual(localParts(evening, tz), { day: '2026-11-21', hour: 20, minute: 30 });
  assert.deepEqual(localParts(new Date('2026-07-01T15:30:00Z'), tz), { day: '2026-07-01', hour: 8, minute: 30 });
  assert.equal(slotFor(AM, 0), 'morning');
  assert.equal(slotFor(PM, 0), 'evening');
  assert.equal(slotFor('', 21), 'evening');
});

test('remind: morning lists every game not yet done, with Play actions', () => {
  let d = withDefaults(emptyData());
  d = setEntry(d, { gameId: 'farflung', day: '2026-11-20', score: 300 });
  const msg = buildReminder(d, { now: morning, tz, schedule: AM, trackerUrl: 'https://t.example/' });
  assert.equal(msg.title, "Today's dailies (2)");
  assert.match(msg.message, /Catfishing/);
  assert.match(msg.message, /Farflung · 🔥1 at risk/);
  assert.equal(msg.click, 'https://t.example/');
  assert.deepEqual(msg.actions.map((a) => a.url), ['https://catfishing.net/', 'https://farflung.game/']);
});

test('remind: evening only nags about what is left, and stays quiet when all done', () => {
  let d = withDefaults(emptyData());
  d = setEntry(d, { gameId: 'catfishing', day: '2026-11-21', score: 3 });
  const msg = buildReminder(d, { now: evening, tz, schedule: PM });
  assert.equal(msg.title, 'Still to play: Farflung');
  assert.equal(msg.priority, 4);

  d = setEntry(d, { gameId: 'farflung', day: '2026-11-21', score: 320 });
  assert.equal(buildReminder(d, { now: evening, tz, schedule: PM }), null);
  assert.equal(buildReminder(d, { now: morning, tz, schedule: AM }), null);
  assert.match(buildReminder(d, { now: evening, tz, test: true }).message, /Everything is done/);
});

test('remind: a run delayed past midnight does not nag about the next day', () => {
  const late = new Date('2026-11-22T08:10:00Z'); // 12:10 AM PST Nov 22
  assert.equal(buildReminder(withDefaults(emptyData()), { now: late, tz, schedule: PM }), null);
});

test('remind: archived games are ignored', () => {
  const d = withDefaults(emptyData());
  d.games = d.games.map((g) => (g.id === 'farflung' ? { ...g, archived: true } : g));
  const msg = buildReminder(d, { now: morning, tz, schedule: AM });
  assert.equal(msg.title, "Today's dailies (1)");
});

test('remind: publishes JSON to ntfy', async () => {
  let req;
  const fetchImpl = async (url, init) => {
    req = { url, init };
    return new Response('{}', { status: 200 });
  };
  await sendNtfy({ title: 'x' }, { topic: 'secret-topic', token: 'tk', fetchImpl });
  assert.equal(req.url, 'https://ntfy.sh/');
  assert.equal(req.init.headers.Authorization, 'Bearer tk');
  assert.deepEqual(JSON.parse(req.init.body), { topic: 'secret-topic', title: 'x' });
});
