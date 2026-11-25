import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { GitHubStore, syncData, b64DecodeUtf8, b64EncodeUtf8 } from '../js/github.js';
import { emptyData, findEntry, removeEntry, setEntry, withDefaults } from '../js/model.js';

// Minimal in-memory stand-in for the GitHub Contents API.
function fakeGitHub({ conflictsOnce = false } = {}) {
  const repo = { text: null, sha: null, rev: 0, writes: 0, conflictsLeft: conflictsOnce ? 1 : 0 };
  const handle = (method, url, body) => {
    if (!url.includes('/contents/')) return { status: 200, body: { private: true, permissions: { push: true } } };
    if (method === 'GET') {
      if (repo.text === null) return { status: 404, body: { message: 'Not Found' } };
      return { status: 200, body: { sha: repo.sha, content: b64EncodeUtf8(repo.text) } };
    }
    const req = JSON.parse(body);
    if (repo.conflictsLeft > 0) {
      repo.conflictsLeft--;
      // Simulate another device writing first.
      const other = withDefaults(setEntry(emptyData(), { gameId: 'farflung', day: '2026-11-21', score: 99, source: 'auto' }));
      repo.text = JSON.stringify(other);
      repo.sha = `sha${++repo.rev}`;
      return { status: 409, body: { message: 'conflict' } };
    }
    if ((req.sha || null) !== repo.sha) return { status: 409, body: { message: 'sha mismatch' } };
    repo.text = b64DecodeUtf8(req.content);
    repo.sha = `sha${++repo.rev}`;
    repo.writes++;
    return { status: repo.rev === 1 ? 201 : 200, body: { content: { sha: repo.sha } } };
  };
  const fetch = async (url, init = {}) => {
    const r = handle(init.method || 'GET', url, init.body);
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  const gmRequest = async ({ method, url, body }) => {
    const r = handle(method, url, body);
    return { status: r.status, text: JSON.stringify(r.body) };
  };
  return { repo, fetch, gmRequest, json: () => JSON.parse(repo.text) };
}

const cfg = { owner: 'me', repo: 'dailies-data', path: 'data.json', token: 't' };

test('github: unicode survives base64 round trip', () => {
  const s = JSON.stringify({ emoji: '🐟🌍', text: 'Ünïcödé' });
  assert.equal(b64DecodeUtf8(b64EncodeUtf8(s)), s);
});

test('github: first sync creates the file, second sync is a no-op', async () => {
  const gh = fakeGitHub();
  const store = new GitHubStore(cfg, gh.fetch);
  const local = withDefaults(setEntry(emptyData(), { gameId: 'catfishing', day: '2026-11-21', score: 3 }));
  const r1 = await syncData(store, local);
  assert.equal(r1.pushed, true);
  assert.equal(gh.json().entries.length, 1);
  const r2 = await syncData(store, r1.data);
  assert.equal(r2.pushed, false);
  assert.equal(gh.repo.writes, 1);
});

test('github: conflict is retried and both devices’ entries are kept', async () => {
  const gh = fakeGitHub({ conflictsOnce: true });
  const store = new GitHubStore(cfg, gh.fetch);
  const local = withDefaults(setEntry(emptyData(), { gameId: 'catfishing', day: '2026-11-21', score: 3 }));
  const r = await syncData(store, local);
  assert.equal(findEntry(r.data, 'catfishing', '2026-11-21').score, 3);
  assert.equal(findEntry(r.data, 'farflung', '2026-11-21').score, 99);
  assert.equal(gh.json().entries.length, 2);
});

// ---------- companion userscript ----------

function loadUserscript() {
  const src = readFileSync(new URL('../userscript/dailies-companion.user.js', import.meta.url), 'utf8');
  const hook = {};
  const ctx = vm.createContext({ __DAILIES_TEST__: hook, TextEncoder, TextDecoder, btoa, atob, console });
  vm.runInContext(src, ctx);
  return hook;
}

const storeOf = (obj) => ({ keys: () => Object.keys(obj), get: (k) => (k in obj ? obj[k] : null) });

const CATFISHING_SAMPLE =
  '{"s":1,"a":[{"r":1},{"r":1},{"r":1},{"r":1},{"r":0,"g":"donald duck"},{"r":1},{"r":2,"g":"sauna"},{"r":2,"g":"royals"},{"r":1},{"r":2,"g":"smells like teen spirit"}],"c":[3,0]}';

const FARFLUNG_SAMPLE = JSON.stringify([
  { p: 'national-flags-blue-white', t: 'traveller', pts: 55, n: 'Israel', e: 1793822292085 },
  { p: 'queen-elizabeth-currency', t: 'traveller', pts: 55, n: 'Australia', e: 1793822292085 },
  { p: 'ice-age-cave-art', t: 'wayfarer', pts: 70, n: 'South Africa', e: 1793822292085 },
  { p: 'undersea-rail-tunnels', t: 'wayfarer', pts: 70, n: 'Hong Kong', e: 1793822292085 },
  { p: 'native-pitcher-plants', t: 'wayfarer', pts: 70, n: 'Brazil', e: 1793822292085 },
]);

test('companion: Catfishing detector reads game-<N> (881 = 2026-11-21)', () => {
  const us = loadUserscript();
  const out = us.detectCatfishing(
    storeOf({
      'game-881': CATFISHING_SAMPLE,
      'game-880': '{"s":0,"a":[],"u":0}',
      settings: '{}',
      'game-bad': 'x',
    }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].day, '2026-11-21');
  assert.equal(out[0].score, 3);
  assert.deepEqual({ ...out[0].details }, { puzzle: 881, correct: 3, close: 0, skipped: 6, wrong: 1 });
});

test('companion: Farflung detector sums pts and reads date from key', () => {
  const us = loadUserscript();
  const key = 'farflung:record:v1:a0665cab-c610-44e4-8dbb-8aedfcea5a4c:log:2026-11-04';
  const partial = JSON.stringify(JSON.parse(FARFLUNG_SAMPLE).slice(0, 3));
  const out = us.detectFarflung(
    storeOf({
      [key]: FARFLUNG_SAMPLE,
      'farflung:record:v1:a0665cab-c610-44e4-8dbb-8aedfcea5a4c:log:2026-11-21': partial,
      'farflung:settings': '{}',
    }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].day, '2026-11-04');
  assert.equal(out[0].score, 320);
  assert.equal(out[0].details.rounds[0].country, 'Israel');
  assert.equal(out[0].loggedAt, new Date(1793822292085).toISOString());

  const done = us.detectFarflung(
    storeOf({
      'farflung:record:v1:abc:log:2026-11-21': partial,
      'farflung:record:v1:abc:run:2026-11-21': '{"id":"x","done":true}',
    }),
  );
  assert.equal(done.length, 1, 'a finished run counts even with fewer than 5 rounds');
  assert.equal(done[0].score, 180);

  const mixed = us.detectFarflung(
    storeOf({
      'farflung:record:v1:A:log:2026-11-21': partial,
      'farflung:record:v1:B:run:2026-11-21': '{"done":true}',
    }),
  );
  assert.equal(mixed.length, 0, "profile B's finished run must not complete profile A's partial log");
});

test('companion: never overrides manual edits or deletions, but refreshes auto scores', () => {
  const us = loadUserscript();
  let remote = setEntry(emptyData(), { gameId: 'catfishing', day: '2026-11-20', score: 7, source: 'manual' });
  remote = removeEntry(remote, 'catfishing', '2026-11-19');
  remote = setEntry(remote, { gameId: 'farflung', day: '2026-11-18', score: 100, source: 'auto' });
  const detected = [
    { gameId: 'catfishing', day: '2026-11-20', score: 3 },
    { gameId: 'catfishing', day: '2026-11-19', score: 3 },
    { gameId: 'farflung', day: '2026-11-18', score: 320 },
    { gameId: 'catfishing', day: '2026-11-21', score: 5 },
  ];
  const { data, applied } = us.applyDetected(remote, detected);
  assert.equal(applied.length, 2);
  assert.equal(findEntry(data, 'catfishing', '2026-11-20').score, 7);
  assert.equal(findEntry(data, 'catfishing', '2026-11-19'), null);
  assert.equal(findEntry(data, 'farflung', '2026-11-18').score, 320);
  assert.equal(findEntry(data, 'catfishing', '2026-11-21').source, 'auto');
});

test('companion: uploads to GitHub, retrying on conflict', async () => {
  const us = loadUserscript();
  const gh = fakeGitHub({ conflictsOnce: true });
  const client = us.githubClient(cfg, gh.gmRequest);
  const applied = await us.uploadDetected(client, [{ gameId: 'catfishing', day: '2026-11-21', score: 3 }]);
  assert.equal(applied.length, 1);
  const saved = gh.json();
  assert.equal(findEntry(saved, 'catfishing', '2026-11-21').score, 3);
  assert.equal(findEntry(saved, 'farflung', '2026-11-21').score, 99, 'other device’s write preserved');
  assert.equal(saved.games.length, 3, 'games written by the tracker are untouched');

  const again = await us.uploadDetected(client, [{ gameId: 'catfishing', day: '2026-11-21', score: 3 }]);
  assert.equal(again.length, 0);
});
