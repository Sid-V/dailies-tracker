import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alreadySent, buildReminder, currentSlot, localParts, run, sendNtfy, slotStartEpoch } from '../reminders/remind.js';
import { emptyData, setEntry, withDefaults } from '../js/model.js';

const tz = 'America/Los_Angeles';
const pst = (day, hm) => new Date(`${day}T${hm}:00-08:00`);
const morning = pst('2026-11-21', '08:30');
const evening = pst('2026-11-21', '20:30');

test('remind: windows follow the reminder timezone, including DST', () => {
  assert.deepEqual(localParts(evening, tz), { day: '2026-11-21', hour: 20, minute: 30, second: 0 });
  assert.equal(currentSlot(pst('2026-11-21', '08:29'), tz), null);
  assert.equal(currentSlot(morning, tz), 'morning');
  assert.equal(currentSlot(pst('2026-11-21', '14:59'), tz), 'morning');
  assert.equal(currentSlot(pst('2026-11-21', '15:00'), tz), null);
  assert.equal(currentSlot(pst('2026-11-21', '20:29'), tz), null);
  assert.equal(currentSlot(evening, tz), 'evening');
  assert.equal(currentSlot(pst('2026-11-21', '23:59'), tz), 'evening');
  assert.equal(currentSlot(new Date('2026-07-01T08:45:00-07:00'), tz), 'morning');
  assert.equal(currentSlot(new Date('2026-07-01T08:15:00-07:00'), tz), null);
});

test('remind: slot start is 8:30 / 20:30 local, even when the run is late', () => {
  const late = pst('2026-11-21', '10:47');
  assert.equal(slotStartEpoch(late, tz, 'morning'), morning.getTime() / 1000);
  assert.equal(slotStartEpoch(pst('2026-11-21', '23:05'), tz, 'evening'), evening.getTime() / 1000);
});

test('remind: workflow crons cover both windows in PST and PDT', async () => {
  const { readFile } = await import('node:fs/promises');
  const yml = await readFile(new URL('../reminders/reminders.yml', import.meta.url), 'utf8');
  const crons = [...yml.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1]);
  const hours = new Set();
  for (const c of crons) {
    const [, h] = c.split(' ');
    const [a, b = a] = h.split('-').map(Number);
    for (let x = a; x <= b; x++) hours.add(x);
  }
  // First quarter-hour run inside each window, in UTC, for winter (-8) and summer (-7).
  for (const offset of [8, 7]) {
    for (const localHour of [8, 20]) assert.ok(hours.has((localHour + offset) % 24), `missing UTC hour for ${localHour}:30 at -${offset}`);
  }
});

test('remind: morning lists every game not yet done, with Play actions', () => {
  let d = withDefaults(emptyData());
  d = setEntry(d, { gameId: 'farflung', day: '2026-11-20', score: 300 });
  const msg = buildReminder(d, { now: morning, tz, slot: 'morning', trackerUrl: 'https://t.example/' });
  assert.equal(msg.title, "Today's dailies (2)");
  assert.match(msg.message, /Catfishing/);
  assert.match(msg.message, /Farflung · 🔥1 at risk/);
  assert.equal(msg.click, 'https://t.example/');
  assert.deepEqual(msg.actions.map((a) => a.url), ['https://catfishing.net/', 'https://farflung.game/']);
});

test('remind: evening only nags about what is left, and stays quiet when all done', () => {
  let d = withDefaults(emptyData());
  d = setEntry(d, { gameId: 'catfishing', day: '2026-11-21', score: 3 });
  const msg = buildReminder(d, { now: evening, tz, slot: 'evening' });
  assert.equal(msg.title, 'Still to play: Farflung');
  assert.equal(msg.priority, 4);

  d = setEntry(d, { gameId: 'farflung', day: '2026-11-21', score: 320 });
  assert.equal(buildReminder(d, { now: evening, tz, slot: 'evening' }), null);
  assert.match(buildReminder(d, { now: evening, tz, test: true }).message, /Everything is done/);
});

test('remind: LeetCode is included from the day it was added', () => {
  const day = '2026-11-25';
  let d = withDefaults(emptyData());
  d = setEntry(d, { gameId: 'catfishing', day, score: 3 });
  d = setEntry(d, { gameId: 'farflung', day, score: 300 });
  const msg = buildReminder(d, { now: pst(day, '20:30'), tz, slot: 'evening' });
  assert.equal(msg.title, 'Still to play: LeetCode daily');
  d = setEntry(d, { gameId: 'leetcode', day });
  assert.equal(buildReminder(d, { now: pst(day, '20:30'), tz, slot: 'evening' }), null);
});

test('remind: archived games are ignored', () => {
  const d = withDefaults(emptyData());
  d.games = d.games.map((g) => (g.id === 'farflung' ? { ...g, archived: true } : g));
  const msg = buildReminder(d, { now: morning, tz, slot: 'morning' });
  assert.equal(msg.title, "Today's dailies (1)");
});

// Fake ntfy server that records published messages and answers polls from them.
function fakeNtfy() {
  const published = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      published.push({ ...body, event: 'message', time: Math.floor(fakeNtfy.now / 1000) });
      return new Response('{}', { status: 200 });
    }
    const since = Number(new URL(url).searchParams.get('since'));
    const lines = published.filter((m) => m.time >= since).map((m) => JSON.stringify(m));
    return new Response(lines.join('\n') + (lines.length ? '\n' : ''), { status: 200 });
  };
  return { published, fetchImpl };
}

test('remind: polling every 15 min sends exactly one reminder per window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remind-'));
  try {
    const file = join(dir, 'data.json');
    await writeFile(file, JSON.stringify(withDefaults(emptyData())));
    const env = { NTFY_TOPIC: 'topic', DATA_FILE: file, REMINDER_TZ: tz };
    const ntfy = fakeNtfy();
    const log = () => {};
    // Simulate a whole day of 15-minute runs (including GitHub's gaps not mattering).
    for (let m = 0; m < 24 * 60; m += 15) {
      const now = new Date(pst('2026-11-21', '00:00').getTime() + m * 60_000);
      fakeNtfy.now = now.getTime();
      await run(env, { now, fetchImpl: ntfy.fetchImpl, log });
    }
    assert.deepEqual(
      ntfy.published.map((p) => [p.title, new Date(p.time * 1000).toISOString()]),
      [
        ["Today's dailies (2)", '2026-11-21T16:30:00.000Z'],
        ['Still to play: Catfishing, Farflung', '2026-11-22T04:30:00.000Z'],
      ],
    );

    // A test notification earlier in the window must not block the real one.
    const n2 = fakeNtfy();
    fakeNtfy.now = pst('2026-11-21', '08:31').getTime();
    await run({ ...env, TEST: 'true' }, { now: new Date(fakeNtfy.now), fetchImpl: n2.fetchImpl, log });
    fakeNtfy.now = pst('2026-11-21', '09:45').getTime();
    await run(env, { now: new Date(fakeNtfy.now), fetchImpl: n2.fetchImpl, log });
    assert.deepEqual(n2.published.map((p) => p.title), ['Dailies reminders are working ✅', "Today's dailies (2)"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('remind: a game finished after the morning reminder is left out at night', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remind-'));
  try {
    const file = join(dir, 'data.json');
    const env = { NTFY_TOPIC: 'topic', DATA_FILE: file, REMINDER_TZ: tz };
    const ntfy = fakeNtfy();
    await writeFile(file, JSON.stringify(withDefaults(emptyData())));
    fakeNtfy.now = morning.getTime();
    await run(env, { now: morning, fetchImpl: ntfy.fetchImpl, log: () => {} });
    await writeFile(file, JSON.stringify(setEntry(withDefaults(emptyData()), { gameId: 'catfishing', day: '2026-11-21', score: 5 })));
    fakeNtfy.now = evening.getTime();
    await run(env, { now: evening, fetchImpl: ntfy.fetchImpl, log: () => {} });
    assert.deepEqual(ntfy.published.map((p) => p.title), ["Today's dailies (2)", 'Still to play: Farflung']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('remind: publishes JSON to ntfy and polls with since', async () => {
  const reqs = [];
  const fetchImpl = async (url, init = {}) => {
    reqs.push({ url, init });
    return new Response(init.method === 'POST' ? '{}' : '{"event":"open"}\n', { status: 200 });
  };
  await sendNtfy({ title: 'x' }, { topic: 'secret-topic', token: 'tk', fetchImpl });
  assert.equal(reqs[0].url, 'https://ntfy.sh/');
  assert.equal(reqs[0].init.headers.Authorization, 'Bearer tk');
  assert.deepEqual(JSON.parse(reqs[0].init.body), { topic: 'secret-topic', title: 'x' });
  assert.equal(await alreadySent({ topic: 'secret-topic', since: 123, fetchImpl }), false);
  assert.equal(reqs[1].url, 'https://ntfy.sh/secret-topic/json?poll=1&since=123');
});
