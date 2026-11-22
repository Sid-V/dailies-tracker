// ==UserScript==
// @name         Dailies Companion
// @namespace    dailies-tracker
// @version      1.0.0
// @description  Notices when you finish a daily game (Catfishing, Farflung) and logs it to your Dailies tracker's GitHub data file.
// @match        https://catfishing.net/*
// @match        https://www.catfishing.net/*
// @match        https://farflung.game/*
// @match        https://www.farflung.game/*
// @match        https://*.github.io/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.0.0';
  const POLL_MS = 4000;

  // ---------- dates ----------

  const pad = (n) => String(n).padStart(2, '0');
  const addDays = (day, n) => {
    const [y, m, d] = day.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  };
  const isoOrNull = (ms) => (typeof ms === 'number' && ms > 1e12 && ms < 1e14 ? new Date(ms).toISOString() : null);

  const parseJson = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };

  // ---------- detectors ----------
  // Each detector gets { keys(): string[], get(key): string|null } and returns finished days.

  // Catfishing stores `game-<N>`; puzzle #881 was 2026-11-21, so #0 is 2024-06-23.
  const CATFISHING_DAY0 = '2024-06-23';
  const CATFISHING_RESULT = { 0: 'wrong', 1: 'skipped', 2: 'correct', 3: 'close' };

  function detectCatfishing(store) {
    const out = [];
    for (const key of store.keys()) {
      const m = /^game-(\d+)$/.exec(key);
      if (!m) continue;
      const g = parseJson(store.get(key));
      if (!g || g.s !== 1 || !Array.isArray(g.c)) continue;
      const counts = { correct: 0, close: 0, skipped: 0, wrong: 0 };
      if (Array.isArray(g.a)) {
        for (const ans of g.a) {
          const k = CATFISHING_RESULT[ans && ans.r];
          if (k) counts[k]++;
        }
      }
      const correct = Number(g.c[0]) || 0;
      out.push({
        gameId: 'catfishing',
        day: addDays(CATFISHING_DAY0, Number(m[1])),
        score: correct,
        details: { puzzle: Number(m[1]), ...counts, correct, close: Number(g.c[1]) || 0 },
      });
    }
    return out;
  }

  // Farflung stores rounds in `farflung:record:v1:<profile>:log:YYYY-MM-DD` (older: `farflung:log:YYYY-MM-DD`)
  // and run state in the matching `:run:` key. Logs and runs are paired per profile.
  const FARFLUNG_KEY = /^farflung:(?:record:v1:([^:]+):)?(log|run):(\d{4}-\d{2}-\d{2})$/;
  const FARFLUNG_ROUNDS = 5;

  function detectFarflung(store) {
    const byDay = new Map();
    for (const key of store.keys()) {
      const m = FARFLUNG_KEY.exec(key);
      if (!m) continue;
      const [, profile = '', kind, day] = m;
      const value = parseJson(store.get(key));
      if (!byDay.has(day)) byDay.set(day, new Map());
      const profiles = byDay.get(day);
      if (!profiles.has(profile)) profiles.set(profile, {});
      if (kind === 'log' && Array.isArray(value)) profiles.get(profile).log = value;
      if (kind === 'run' && value && typeof value === 'object') profiles.get(profile).run = value;
    }
    const out = [];
    for (const [day, profiles] of byDay) {
      let best = null;
      for (const { log, run } of profiles.values()) {
        if (!log) continue;
        const runDone = !!run && (run.done === true || !!run.completedAt);
        if (!runDone && log.length < FARFLUNG_ROUNDS) continue;
        const lastAt = Math.max(0, ...log.map((r) => (r && typeof r.e === 'number' ? r.e : 0)));
        const at = (typeof run?.completedAt === 'number' && run.completedAt) || lastAt;
        if (!best || at > best.at || (at === best.at && log.length > best.log.length)) best = { log, run, at, lastAt };
      }
      if (!best) continue;
      const pts = best.log.map((r) => (r && typeof r.pts === 'number' ? r.pts : 0));
      out.push({
        gameId: 'farflung',
        day,
        score: pts.reduce((a, b) => a + b, 0),
        details: {
          rounds: best.log.map((r, i) => ({ country: r?.n ?? null, tier: r?.t ?? null, pts: pts[i] })),
        },
        loggedAt: isoOrNull(best.run?.completedAt) || isoOrNull(best.lastAt),
      });
    }
    return out;
  }

  const DETECTORS = [
    { gameId: 'catfishing', hosts: ['catfishing.net', 'www.catfishing.net'], name: 'Catfishing', detect: detectCatfishing },
    { gameId: 'farflung', hosts: ['farflung.game', 'www.farflung.game'], name: 'Farflung', detect: detectFarflung },
  ];

  // ---------- data merge ----------

  const entryKey = (e) => `${e.gameId}|${e.day}`;
  const signature = (e) => JSON.stringify([e.score]);

  // Adds detected days to the shared data. Never overrides manual edits or deletions.
  function applyDetected(remote, detected, now = new Date()) {
    const data = {
      version: 1,
      games: Array.isArray(remote?.games) ? remote.games : [],
      entries: Array.isArray(remote?.entries) ? [...remote.entries] : [],
    };
    const idx = new Map(data.entries.map((e, i) => [entryKey(e), i]));
    const applied = [];
    for (const e of detected) {
      const i = idx.get(entryKey(e));
      const cur = i === undefined ? null : data.entries[i];
      if (cur && (cur.deleted || cur.source !== 'auto' || cur.score === e.score)) continue;
      // Never stamp earlier than the record being replaced (guards against clock skew).
      const prev = cur && cur.updatedAt ? Date.parse(cur.updatedAt) || 0 : 0;
      const ts = new Date(Math.max(now.getTime(), prev + 1)).toISOString();
      const next = {
        gameId: e.gameId,
        day: e.day,
        score: e.score,
        source: 'auto',
        loggedAt: cur?.loggedAt || e.loggedAt || ts,
        updatedAt: ts,
        ...(e.details ? { details: e.details } : {}),
      };
      if (i === undefined) {
        idx.set(entryKey(e), data.entries.length);
        data.entries.push(next);
      } else data.entries[i] = next;
      applied.push(next);
    }
    data.entries.sort((a, b) => a.day.localeCompare(b.day) || a.gameId.localeCompare(b.gameId));
    return { data, applied };
  }

  // ---------- GitHub ----------

  function b64EncodeUtf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64DecodeUtf8(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  // GM.xmlHttpRequest sidesteps the game sites' Content-Security-Policy; fetch is a fallback.
  function httpRequest({ method, url, headers, body }) {
    const gm =
      (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest) ||
      (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null);
    if (gm) {
      return new Promise((resolve, reject) => {
        gm({
          method,
          url,
          headers,
          data: body,
          nocache: true,
          timeout: 20000,
          onload: (r) => resolve({ status: r.status, text: r.responseText }),
          onerror: () => reject(new Error('Network error')),
          ontimeout: () => reject(new Error('Timed out')),
        });
      });
    }
    return fetch(url, { method, headers, body, cache: 'no-store' }).then(async (r) => ({ status: r.status, text: await r.text() }));
  }

  function githubClient(cfg, request = httpRequest) {
    const path = String(cfg.path || 'data.json').split('/').map(encodeURIComponent).join('/');
    const base = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`;
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    return {
      async read() {
        const ref = cfg.branch ? `?ref=${encodeURIComponent(cfg.branch)}` : '';
        const r = await request({ method: 'GET', url: base + ref, headers: { ...headers, 'Cache-Control': 'no-cache' } });
        if (r.status === 404) return { data: null, sha: null };
        if (r.status !== 200) throw Object.assign(new Error(`GitHub read failed (${r.status})`), { status: r.status });
        const body = JSON.parse(r.text);
        return { data: parseJson(b64DecodeUtf8(body.content || '')) || {}, sha: body.sha };
      },
      async write(data, sha, message) {
        const payload = {
          message,
          content: b64EncodeUtf8(JSON.stringify(data, null, 2) + '\n'),
          ...(sha ? { sha } : {}),
          ...(cfg.branch ? { branch: cfg.branch } : {}),
        };
        const r = await request({
          method: 'PUT',
          url: base,
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (r.status === 409 || r.status === 422) throw Object.assign(new Error('conflict'), { status: 409 });
        if (r.status !== 200 && r.status !== 201)
          throw Object.assign(new Error(`GitHub write failed (${r.status})`), { status: r.status });
      },
    };
  }

  async function uploadDetected(client, detected, attempts = 4) {
    for (let i = 0; ; i++) {
      const remote = await client.read();
      const { data, applied } = applyDetected(remote.data, detected);
      if (!applied.length && remote.data) return applied;
      const label = applied.length === 1 ? `${applied[0].gameId} ${applied[0].day}` : `${applied.length} days`;
      try {
        await client.write(data, remote.sha, `Companion: log ${label}`);
        return applied;
      } catch (err) {
        if (err.status !== 409 || i >= attempts - 1) throw err;
      }
    }
  }

  // ---------- UI ----------

  function toast(text, ms = 3500) {
    if (!document.body) return;
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      bottom: '24px',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      background: '#14161c',
      color: '#e9ebf1',
      border: '1px solid #3fbf7f',
      borderRadius: '12px',
      padding: '10px 16px',
      font: '15px/1.3 system-ui, -apple-system, sans-serif',
      boxShadow: '0 6px 24px rgba(0,0,0,.35)',
      pointerEvents: 'none',
      maxWidth: '90vw',
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // ---------- runtime ----------

  const pageStorage = {
    keys: () => {
      try {
        return Object.keys(window.localStorage);
      } catch {
        return [];
      }
    },
    get: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
  };

  async function linkTracker() {
    document.documentElement.dataset.dailiesCompanion = VERSION;
    document.dispatchEvent(new Event('dailies-companion'));
    const cfg = parseJson(pageStorage.get('dailies:config') || 'null');
    if (!cfg || !cfg.token || !cfg.owner || !cfg.repo) return;
    const here = location.origin + location.pathname.replace(/[^/]*$/, '');
    const linked = await GM.getValue('trackerUrl', null);
    if (linked !== here) {
      const ok = window.confirm(
        `Link Dailies Companion to the tracker at\n${here}\n\nIt will use this tracker's GitHub settings to log the games you finish.`,
      );
      if (!ok) return;
      await GM.setValue('trackerUrl', here);
    }
    const cur = await GM.getValue('config', null);
    if (JSON.stringify(cur) !== JSON.stringify(cfg)) {
      await GM.setValue('config', cfg);
      toast('\u2713 Dailies Companion linked to this tracker');
    }
  }

  function watchGame(det) {
    let busy = false;
    let warnedUnlinked = false;
    let failures = 0;
    let nextTry = 0;

    async function scan() {
      if (busy || Date.now() < nextTry) return;
      busy = true;
      try {
        const reported = (await GM.getValue('reported', {})) || {};
        const pending = det.detect(pageStorage).filter((e) => reported[entryKey(e)] !== signature(e));
        if (!pending.length) return;
        const cfg = await GM.getValue('config', null);
        if (!cfg) {
          if (!warnedUnlinked) toast('Dailies: open your tracker once in this browser to link the companion script.', 6000);
          warnedUnlinked = true;
          return;
        }
        const applied = await uploadDetected(githubClient(cfg), pending);
        for (const e of pending) reported[entryKey(e)] = signature(e);
        await GM.setValue('reported', reported);
        failures = 0;
        if (applied.length === 1) {
          const e = applied[0];
          const score = det.gameId === 'catfishing' ? `${e.score}/10` : `${e.score} pts`;
          toast(`\u2713 Dailies: logged ${det.name} ${score}`);
        } else if (applied.length > 1) {
          toast(`\u2713 Dailies: synced ${applied.length} ${det.name} days`);
        }
      } catch (err) {
        failures++;
        nextTry = Date.now() + Math.min(5 * 60_000, 5000 * 2 ** failures);
        if (failures === 1 || err.status === 401) toast(`\u26A0 Dailies: ${err.message}`, 6000);
        console.warn('[Dailies Companion]', err);
      } finally {
        busy = false;
      }
    }

    setTimeout(scan, 1500);
    setInterval(() => document.visibilityState === 'visible' && scan(), POLL_MS);
    document.addEventListener('visibilitychange', () => scan());
    window.addEventListener('pagehide', () => scan());
  }

  function main() {
    if (document.querySelector('meta[name="dailies-tracker"]')) {
      linkTracker().catch((e) => console.warn('[Dailies Companion]', e));
      return;
    }
    const det = DETECTORS.find((d) => d.hosts.includes(location.hostname));
    if (det) watchGame(det);
  }

  const testHook = typeof globalThis !== 'undefined' && globalThis.__DAILIES_TEST__;
  if (testHook && typeof testHook === 'object') {
    Object.assign(testHook, { detectCatfishing, detectFarflung, applyDetected, uploadDetected, githubClient, addDays, b64DecodeUtf8, b64EncodeUtf8 });
  } else {
    main();
  }
})();
