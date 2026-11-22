import { today, addDays, dayRange, formatDay } from './dates.js';
import {
  DETECTORS,
  activeGames,
  canonical,
  emptyData,
  findEntry,
  formatScore,
  merge,
  normalize,
  removeEntry,
  sameData,
  setEntry,
  upsertGame,
  withDefaults,
} from './model.js';
import { gameStats, overallStats } from './stats.js';
import { GitHubStore, syncData } from './github.js';

const LS_DATA = 'dailies:data';
const LS_CONFIG = 'dailies:config';
const LS_LAST_SYNC = 'dailies:lastSync';
const COMPANION_PATH = 'userscript/dailies-companion.user.js';

const view = document.getElementById('view');
const syncBtn = document.getElementById('sync-status');
const dayDialog = document.getElementById('day-dialog');
const dayForm = document.getElementById('day-form');

const readJson = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
};

let data = withDefaults(readJson(LS_DATA) || emptyData());
let config = readJson(LS_CONFIG);
let sync = { status: config ? 'idle' : 'off', message: '', at: localStorage.getItem(LS_LAST_SYNC) };
let companion = document.documentElement.dataset.dailiesCompanion || null;
let markingGame = null;
let pendingPlay = null;
let flash = '';

// ---------- helpers ----------

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const safeUrl = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '#';
  } catch {
    return '#';
  }
};

const parseScore = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const fmtNum = (n) => (n === null || n === undefined ? '–' : Number.isInteger(n) ? String(n) : n.toFixed(1));

function persist(next, { push = true } = {}) {
  data = canonical(next);
  localStorage.setItem(LS_DATA, JSON.stringify(data));
  render();
  if (push) scheduleSync();
}

// ---------- sync ----------

let syncTimer = null;
let syncing = null;
let syncAgain = false;

function scheduleSync(delay = 800) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}

async function runSync() {
  if (!config) {
    sync = { status: 'off', message: '', at: null };
    renderSync();
    return;
  }
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  sync = { ...sync, status: 'syncing' };
  renderSync();
  syncing = (async () => {
    try {
      const store = new GitHubStore(config);
      const result = await syncData(store, data, { message: `Dailies sync ${new Date().toISOString()}` });
      // Keep anything logged locally while the request was in flight.
      data = canonical(withDefaults(merge(result.data, data)));
      localStorage.setItem(LS_DATA, JSON.stringify(data));
      const at = new Date().toISOString();
      localStorage.setItem(LS_LAST_SYNC, at);
      sync = { status: 'ok', message: '', at };
      if (!sameData(result.data, data)) syncAgain = true;
    } catch (err) {
      sync = { ...sync, status: navigator.onLine === false ? 'offline' : 'error', message: err.message || String(err) };
    } finally {
      syncing = null;
      render();
      afterPlayCheck();
      if (syncAgain) {
        syncAgain = false;
        scheduleSync(200);
      }
    }
  })();
  return syncing;
}

function renderSync() {
  const labels = {
    off: ['○ Local only', 'Not connected to GitHub; data is only on this device.'],
    idle: ['⟳ Sync', 'Sync now'],
    syncing: ['⟳ Syncing…', 'Syncing with GitHub'],
    ok: ['✓ Synced', `Last synced ${sync.at ? new Date(sync.at).toLocaleTimeString() : ''}`],
    offline: ['⚠ Offline', 'Offline: changes are saved here and will sync later.'],
    error: ['⚠ Sync error', sync.message],
  };
  const [text, title] = labels[sync.status] || labels.idle;
  syncBtn.textContent = text;
  syncBtn.title = title;
  syncBtn.className = `sync ${sync.status}`;
}

// When returning from a game tab: pull fresh data, then offer manual logging if nothing arrived.
function afterPlayCheck() {
  if (!pendingPlay || syncing) return;
  const { gameId, day } = pendingPlay;
  pendingPlay = null;
  const game = activeGames(data).find((g) => g.id === gameId);
  if (!game || findEntry(data, gameId, day)) return;
  const autoExpected = companion && game.detector;
  if (!autoExpected && route().name === 'today') {
    markingGame = gameId;
    render();
    view.querySelector(`[data-mark-form="${CSS.escape(gameId)}"] input`)?.focus();
  }
}

// ---------- routing ----------

function route() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('game/')) return { name: 'game', id: decodeURIComponent(h.slice(5)) };
  if (h === 'stats') return { name: 'stats' };
  if (h === 'settings') return { name: 'settings' };
  return { name: 'today' };
}

function render() {
  renderSync();
  const r = route();
  document.querySelectorAll('.tabs a').forEach((a) => {
    const tab = a.dataset.tab;
    a.classList.toggle('active', tab === r.name || (tab === 'stats' && r.name === 'game'));
  });
  const t = today();
  if (r.name === 'today') view.innerHTML = renderToday(t);
  else if (r.name === 'stats') view.innerHTML = renderStats(t);
  else if (r.name === 'game') view.innerHTML = renderGame(r.id, t);
  else view.innerHTML = renderSettings();
  if (flash) {
    view.insertAdjacentHTML('afterbegin', `<p class="flash">${esc(flash)}</p>`);
    flash = '';
  }
}

// ---------- views ----------

function renderToday(t) {
  const games = activeGames(data);
  const o = overallStats(data, t);
  const cards = games
    .map((g) => {
      const s = gameStats(data, g.id, t);
      const e = findEntry(data, g.id, t);
      const streak = s.current
        ? `<span class="streak${s.atRisk ? ' risk' : ''}" title="${s.atRisk ? 'Play today to keep it' : 'Current streak'}">🔥 ${s.current}</span>`
        : '';
      const status = e
        ? `<span class="status done">✔ Done${formatScore(g, e) ? ` · ${esc(formatScore(g, e))}` : ''}</span><span class="source">${esc(e.source || '')}</span>`
        : `<span class="status todo">${s.atRisk ? 'Streak at risk' : 'Not done yet'}</span>`;
      const markForm =
        markingGame === g.id && !e
          ? `<form class="mark" data-mark-form="${esc(g.id)}">
               <input type="number" name="score" step="any" inputmode="decimal" placeholder="Score${g.score?.max ? ` (of ${esc(g.score.max)})` : ''} – optional" />
               <button class="btn primary" type="submit">Save</button>
               <button class="btn" type="button" data-act="cancel-mark">Cancel</button>
             </form>`
          : '';
      return `<li class="card ${e ? 'is-done' : ''}">
          <div class="card-head">
            <span class="emoji">${esc(g.emoji || '🎮')}</span>
            <a class="name" href="#game/${encodeURIComponent(g.id)}">${esc(g.name)}</a>
            ${streak}
          </div>
          <div class="card-body">${status}</div>
          <div class="card-actions">
            <a class="btn primary" href="${esc(safeUrl(g.url))}" target="_blank" rel="noopener noreferrer" data-act="play" data-game="${esc(g.id)}">Play ↗</a>
            ${e ? (e.source === 'manual' ? `<button class="btn" data-act="undo" data-game="${esc(g.id)}">Undo</button>` : '') : `<button class="btn" data-act="mark" data-game="${esc(g.id)}">Mark done</button>`}
          </div>
          ${markForm}
        </li>`;
    })
    .join('');
  const allStreak = o.allCurrent
    ? `<span class="streak${o.allAtRisk ? ' risk' : ''}">🔥 ${o.allCurrent}-day all-dailies streak</span>`
    : '';
  const hint = !config
    ? `<p class="hint">Not syncing yet. <a href="#settings">Connect GitHub</a> to share progress across devices.</p>`
    : '';
  return `<section class="summary">
      <div class="date">${esc(formatDay(t, { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
      <div class="progress"><strong>${o.doneToday} / ${o.gameCount}</strong> done today ${allStreak}</div>
    </section>
    ${hint}
    <ul class="cards">${cards || '<li class="empty">No games yet. Add one in Settings.</li>'}</ul>`;
}

function renderStats(t) {
  const o = overallStats(data, t);
  const rows = activeGames(data)
    .map((g) => {
      const s = gameStats(data, g.id, t);
      return `<a class="stat-row" href="#game/${encodeURIComponent(g.id)}">
          <span class="emoji">${esc(g.emoji || '🎮')}</span>
          <span class="name">${esc(g.name)}</span>
          <span>🔥 ${s.current}</span>
          <span class="muted">best ${s.longest} · ${s.total} days</span>
        </a>`;
    })
    .join('');
  return `<section class="panel">
      <h2>Overall</h2>
      <div class="grid">
        ${tile('All-dailies streak', o.allCurrent)}
        ${tile('Longest all-dailies', o.allLongest)}
        ${tile('Days played', o.daysPlayed)}
        ${tile('Today', `${o.doneToday}/${o.gameCount}`)}
      </div>
    </section>
    <section class="panel"><h2>Games</h2>${rows || '<p class="muted">No games.</p>'}</section>`;
}

const tile = (label, value) => `<div class="tile"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;

function renderGame(id, t) {
  const g = canonical(data).games.find((x) => x.id === id);
  if (!g) return `<p>Game not found. <a href="#stats">Back</a></p>`;
  const s = gameStats(data, g.id, t);
  const weeks = 15;
  // Calendar ends on the Saturday of this week so columns line up Sun..Sat.
  const [y, m, d] = t.split('-').map(Number);
  const endDay = addDays(t, 6 - new Date(y, m - 1, d).getDay());
  const days = dayRange(endDay, weeks * 7);
  const cells = days
    .map((day) => {
      const e = s.byDay.get(day);
      const future = day > t;
      const cls = future ? 'future' : e ? 'on' : 'off';
      const title = `${formatDay(day)}${e ? ` – done${formatScore(g, e) ? ` (${formatScore(g, e)})` : ''}` : ''}`;
      return future
        ? `<span class="cell ${cls}"></span>`
        : `<button class="cell ${cls}${day === t ? ' today' : ''}" data-act="edit-day" data-game="${esc(g.id)}" data-day="${esc(day)}" title="${esc(title)}" aria-label="${esc(title)}"></button>`;
    })
    .join('');
  const recent = [...s.byDay.values()]
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, 30)
    .map(
      (e) => `<li>
        <button class="linkish" data-act="edit-day" data-game="${esc(g.id)}" data-day="${esc(e.day)}">${esc(formatDay(e.day))}</button>
        <span>${esc(formatScore(g, e) || '✔')}</span>
        <span class="muted">${esc(e.source || '')}</span>
      </li>`,
    )
    .join('');
  return `<section class="panel">
      <div class="game-title">
        <span class="emoji big">${esc(g.emoji || '🎮')}</span>
        <h2>${esc(g.name)}</h2>
        <a class="btn primary" href="${esc(safeUrl(g.url))}" target="_blank" rel="noopener noreferrer" data-act="play" data-game="${esc(g.id)}">Play ↗</a>
      </div>
      <div class="grid">
        ${tile('Current streak', s.current)}
        ${tile('Longest streak', s.longest)}
        ${tile('Days played', s.total)}
        ${tile(`Average ${g.score?.label || 'score'}`, fmtNum(s.average))}
        ${tile(`Best ${g.score?.label || 'score'}`, fmtNum(s.best))}
        ${tile('Since', s.firstDay ? formatDay(s.firstDay, { month: 'short', day: 'numeric', year: 'numeric' }) : '–')}
      </div>
    </section>
    <section class="panel">
      <h2>Last ${weeks} weeks</h2>
      <div class="cal">${cells}</div>
      <p class="muted small">Tap a day to mark it done, change the score, or clear it.</p>
    </section>
    <section class="panel">
      <h2>Recent</h2>
      <ul class="recent">${recent || '<li class="muted">Nothing logged yet.</li>'}</ul>
    </section>`;
}

function renderSettings() {
  const c = config || {};
  const games = canonical(data).games;
  const detectorOpts = (sel) =>
    ['', ...DETECTORS]
      .map((d) => `<option value="${d}"${(sel || '') === d ? ' selected' : ''}>${d ? esc(d) : 'none (manual only)'}</option>`)
      .join('');
  const gameForms = games
    .map(
      (g, i) => `<details class="game-edit">
        <summary>${esc(g.emoji || '🎮')} ${esc(g.name)}${g.archived ? ' <span class="muted">(archived)</span>' : ''}</summary>
        <form data-form="game" data-id="${esc(g.id)}">
          ${gameFields(g, detectorOpts)}
          <label class="row"><input type="checkbox" name="archived"${g.archived ? ' checked' : ''} /> Archived (hidden from Today)</label>
          <div class="actions">
            <button class="btn" type="button" data-act="move" data-id="${esc(g.id)}" data-dir="-1"${i === 0 ? ' disabled' : ''}>↑</button>
            <button class="btn" type="button" data-act="move" data-id="${esc(g.id)}" data-dir="1"${i === games.length - 1 ? ' disabled' : ''}>↓</button>
            <button class="btn primary" type="submit">Save</button>
          </div>
        </form>
      </details>`,
    )
    .join('');
  const companionUrl = new URL(COMPANION_PATH, location.href).href;
  return `<section class="panel">
      <h2>Sync (GitHub)</h2>
      <p class="muted small">Progress is stored in a JSON file in a <strong>private</strong> repo. Use a fine-grained token with access to only that repo and <em>Contents: Read and write</em>.</p>
      <form data-form="config" class="stack">
        <label>Owner <input name="owner" required autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(c.owner)}" placeholder="your-github-username" /></label>
        <label>Repo <input name="repo" required autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(c.repo)}" placeholder="dailies-data" /></label>
        <label>File path <input name="path" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(c.path || 'data.json')}" /></label>
        <label>Branch <input name="branch" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(c.branch || '')}" placeholder="(default branch)" /></label>
        <label>Token <input name="token" type="password" ${config ? '' : 'required'} autocomplete="off" placeholder="${config ? '•••••• (unchanged)' : 'github_pat_…'}" /></label>
        <div class="actions">
          ${config ? '<button class="btn" type="button" data-act="disconnect">Disconnect</button>' : ''}
          ${config ? '<button class="btn" type="button" data-act="sync-now">Sync now</button>' : ''}
          <button class="btn primary" type="submit">Save &amp; test</button>
        </div>
      </form>
      <p class="muted small">Status: ${esc(sync.status)}${sync.message ? ` – ${esc(sync.message)}` : ''}${sync.at ? ` · last sync ${esc(new Date(sync.at).toLocaleString())}` : ''}</p>
    </section>
    <section class="panel">
      <h2>Companion script</h2>
      <p>${companion ? `✓ Detected in this browser (v${esc(companion)}).` : '✗ Not detected in this browser.'}</p>
      <p class="muted small">The companion userscript runs on the game sites, notices when you finish a daily and logs it automatically. Install it with Violentmonkey or Tampermonkey (desktop) or the Userscripts app (iPhone/iPad Safari), then reload this page once to link it.</p>
      <p><a class="btn" href="${esc(companionUrl)}">Install companion script</a></p>
    </section>
    <section class="panel">
      <h2>Games</h2>
      ${gameForms}
      <details class="game-edit">
        <summary>＋ Add a game</summary>
        <form data-form="game" data-id="">
          ${gameFields({}, detectorOpts)}
          <div class="actions"><button class="btn primary" type="submit">Add game</button></div>
        </form>
      </details>
    </section>
    <section class="panel">
      <h2>Backup</h2>
      <div class="actions">
        <button class="btn" type="button" data-act="export">Export JSON</button>
        <label class="btn">Import JSON<input type="file" accept="application/json,.json" data-act="import" hidden /></label>
      </div>
      <p class="muted small">Import merges with what's already here; it never deletes.</p>
    </section>`;
}

const gameFields = (g, detectorOpts) => `
  <label>Name <input name="name" required value="${esc(g.name)}" /></label>
  <label>URL <input name="url" type="url" required value="${esc(g.url)}" placeholder="https://…" /></label>
  <label>Emoji <input name="emoji" maxlength="8" value="${esc(g.emoji || '')}" placeholder="🎮" /></label>
  <label>Score label <input name="label" value="${esc(g.score?.label || '')}" placeholder="pts" /></label>
  <label>Score max <input name="max" type="number" step="any" value="${esc(g.score?.max ?? '')}" placeholder="(none)" /></label>
  <label>Auto-detect <select name="detector">${detectorOpts(g.detector)}</select></label>`;

// ---------- day dialog ----------

function openDayDialog(gameId, day) {
  const g = canonical(data).games.find((x) => x.id === gameId);
  const e = findEntry(data, gameId, day);
  document.getElementById('day-title').textContent = `${g?.name || gameId} – ${formatDay(day, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`;
  dayForm.elements.done.checked = !!e;
  dayForm.elements.score.value = e?.score ?? '';
  dayForm.dataset.game = gameId;
  dayForm.dataset.day = day;
  dayDialog.returnValue = '';
  dayDialog.showModal();
}

dayDialog.addEventListener('close', () => {
  if (dayDialog.returnValue !== 'save') return;
  const { game, day } = dayForm.dataset;
  const done = dayForm.elements.done.checked;
  const score = parseScore(dayForm.elements.score.value);
  const existing = findEntry(data, game, day);
  if (!done && score === null) {
    if (existing) persist(removeEntry(data, game, day));
    return;
  }
  persist(
    setEntry(data, {
      gameId: game,
      day,
      score,
      details: existing?.details,
      source: existing && existing.score === score ? existing.source : 'manual',
      loggedAt: existing?.loggedAt,
    }),
  );
});

// ---------- events ----------

view.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const t = today();
  if (act === 'play') {
    pendingPlay = { gameId: el.dataset.game, day: t };
    return;
  }
  if (act === 'import') return;
  ev.preventDefault();
  if (act === 'mark') {
    markingGame = el.dataset.game;
    render();
    view.querySelector(`[data-mark-form="${CSS.escape(markingGame)}"] input`)?.focus();
  } else if (act === 'cancel-mark') {
    markingGame = null;
    render();
  } else if (act === 'undo') {
    persist(removeEntry(data, el.dataset.game, t));
  } else if (act === 'edit-day') {
    openDayDialog(el.dataset.game, el.dataset.day);
  } else if (act === 'sync-now') {
    runSync();
  } else if (act === 'disconnect') {
    if (!confirm('Disconnect GitHub sync on this device? Local data stays.')) return;
    config = null;
    localStorage.removeItem(LS_CONFIG);
    sync = { status: 'off', message: '', at: null };
    render();
  } else if (act === 'move') {
    const games = canonical(data).games;
    const i = games.findIndex((g) => g.id === el.dataset.id);
    const j = i + Number(el.dataset.dir);
    if (i < 0 || j < 0 || j >= games.length) return;
    [games[i], games[j]] = [games[j], games[i]];
    let next = data;
    games.forEach((g, k) => {
      if (g.order !== k) next = upsertGame(next, { ...g, order: k });
    });
    persist(next);
  } else if (act === 'export') {
    const blob = new Blob([JSON.stringify(canonical(data), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dailies-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
});

view.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.dataset?.act !== 'import' || !el.files?.[0]) return;
  try {
    const imported = normalize(JSON.parse(await el.files[0].text()));
    flash = `Imported ${imported.entries.length} entries and ${imported.games.length} games.`;
    persist(merge(data, imported));
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});

view.addEventListener('submit', async (ev) => {
  const form = ev.target;
  ev.preventDefault();
  if (form.dataset.markForm) {
    const gameId = form.dataset.markForm;
    markingGame = null;
    persist(setEntry(data, { gameId, day: today(), score: parseScore(form.elements.score.value), source: 'manual' }));
    return;
  }
  if (form.dataset.form === 'game') {
    const f = form.elements;
    const id = form.dataset.id || undefined;
    const existing = id ? canonical(data).games.find((g) => g.id === id) : null;
    const url = safeUrl(f.url.value.trim());
    if (url === '#') return alert('Please enter an http(s) URL.');
    const game = {
      ...(existing || {}),
      id,
      name: f.name.value.trim(),
      url,
      emoji: f.emoji.value.trim(),
      score: { label: f.label.value.trim(), max: parseScore(f.max.value) },
      detector: f.detector.value || null,
      archived: f.archived ? f.archived.checked : false,
    };
    flash = id ? `Saved ${game.name}.` : `Added ${game.name}.`;
    persist(upsertGame(data, game));
    return;
  }
  if (form.dataset.form === 'config') {
    const f = form.elements;
    const next = {
      owner: f.owner.value.trim(),
      repo: f.repo.value.trim(),
      path: f.path.value.trim() || 'data.json',
      branch: f.branch.value.trim(),
      token: f.token.value.trim() || config?.token || '',
    };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Testing…';
    try {
      const info = await new GitHubStore(next).checkAccess();
      if (info.canPush === false) throw new Error('Token can read but not write this repo.');
      config = next;
      localStorage.setItem(LS_CONFIG, JSON.stringify(config));
      flash = info.private ? 'Connected. Syncing…' : '⚠ Connected, but this repo is PUBLIC – your data will be visible to anyone.';
      sync = { status: 'idle', message: '', at: null };
      render();
      await runSync();
    } catch (err) {
      alert(`Could not connect: ${err.message}`);
      btn.disabled = false;
      btn.textContent = 'Save & test';
    }
  }
});

syncBtn.addEventListener('click', () => (config ? runSync() : (location.hash = '#settings')));
window.addEventListener('hashchange', () => {
  markingGame = null;
  render();
  window.scrollTo(0, 0);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  render();
  if (config) runSync();
  else afterPlayCheck();
});
window.addEventListener('online', () => config && runSync());
window.addEventListener('storage', (e) => {
  if (e.key === LS_DATA) {
    data = withDefaults(readJson(LS_DATA) || emptyData());
    render();
  }
});
document.addEventListener('dailies-companion', () => {
  companion = document.documentElement.dataset.dailiesCompanion || companion;
  if (route().name === 'settings') render();
});
setInterval(() => {
  if (document.visibilityState === 'visible' && config && !syncing) runSync();
}, 60_000);

// Re-render at midnight so "today" rolls over.
(function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  setTimeout(() => {
    render();
    scheduleMidnight();
  }, next - now);
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

localStorage.setItem(LS_DATA, JSON.stringify(data));
render();
if (config) runSync();
