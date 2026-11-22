import { toDay } from './dates.js';

export const DATA_VERSION = 1;
const EPOCH = '1970-01-01T00:00:00.000Z';

// Seeds use an epoch timestamp so any edit synced from another device wins a merge.
export const DEFAULT_GAMES = [
  {
    id: 'catfishing',
    name: 'Catfishing',
    url: 'https://catfishing.net/',
    emoji: '🐟',
    score: { label: 'correct', max: 10 },
    detector: 'catfishing',
    order: 0,
    archived: false,
    updatedAt: EPOCH,
  },
  {
    id: 'farflung',
    name: 'Farflung',
    url: 'https://farflung.game/',
    emoji: '🌍',
    score: { label: 'pts', max: null },
    detector: 'farflung',
    order: 1,
    archived: false,
    updatedAt: EPOCH,
  },
];

export const DETECTORS = ['catfishing', 'farflung'];

export const emptyData = () => ({ version: DATA_VERSION, games: [], entries: [] });

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length < 200;
const isTs = (v) => v === undefined || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));
const isScore = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));

const validGame = (g) => g && typeof g === 'object' && isStr(g.id) && isTs(g.updatedAt);
const validEntry = (e) =>
  e && typeof e === 'object' && isStr(e.gameId) && typeof e.day === 'string' && DAY_RE.test(e.day) && isTs(e.updatedAt) && isScore(e.score);

export function normalize(data) {
  const d = data && typeof data === 'object' ? data : {};
  return {
    version: DATA_VERSION,
    games: Array.isArray(d.games) ? d.games.filter(validGame) : [],
    entries: Array.isArray(d.entries) ? d.entries.filter(validEntry) : [],
  };
}

export const entryKey = (e) => `${e.gameId}|${e.day}`;

// Never go backwards in time relative to the record being replaced, so a device
// with a slow clock can still overwrite something written by a fast one.
export function stampAfter(existing, now = new Date()) {
  const prev = existing?.updatedAt ? Date.parse(existing.updatedAt) : 0;
  return new Date(Math.max(now.getTime(), (Number.isNaN(prev) ? 0 : prev) + 1)).toISOString();
}

const newer = (a, b) => {
  const ta = a.updatedAt || EPOCH;
  const tb = b.updatedAt || EPOCH;
  if (ta !== tb) return ta > tb ? a : b;
  if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
};

function mergeBy(listA, listB, keyFn) {
  const map = new Map();
  for (const item of [...listA, ...listB]) {
    const k = keyFn(item);
    const cur = map.get(k);
    map.set(k, cur ? newer(cur, item) : item);
  }
  return [...map.values()];
}

export function merge(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  return canonical({
    version: DATA_VERSION,
    games: mergeBy(x.games, y.games, (g) => g.id),
    entries: mergeBy(x.entries, y.entries, entryKey),
  });
}

export function canonical(data) {
  const d = normalize(data);
  return {
    version: DATA_VERSION,
    games: [...d.games].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id)),
    entries: [...d.entries].sort((a, b) => a.day.localeCompare(b.day) || a.gameId.localeCompare(b.gameId)),
  };
}

export const sameData = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function withDefaults(data) {
  const d = normalize(data);
  const ids = new Set(d.games.map((g) => g.id));
  const missing = DEFAULT_GAMES.filter((g) => !ids.has(g.id));
  return missing.length ? canonical({ ...d, games: [...d.games, ...missing] }) : d;
}

export const activeGames = (data) =>
  canonical(data).games.filter((g) => !g.archived);

export const liveEntries = (data) => normalize(data).entries.filter((e) => !e.deleted);

export function findEntry(data, gameId, day) {
  return liveEntries(data).find((e) => e.gameId === gameId && e.day === day) || null;
}

export function setEntry(data, { gameId, day, score = null, details, source = 'manual', loggedAt }, now = new Date()) {
  const d = normalize(data);
  const key = `${gameId}|${day}`;
  const ts = stampAfter(d.entries.find((e) => entryKey(e) === key), now);
  const entry = { gameId, day, score, source, loggedAt: loggedAt || now.toISOString(), updatedAt: ts };
  if (details) entry.details = details;
  return canonical({
    ...d,
    entries: [...d.entries.filter((e) => entryKey(e) !== key), entry],
  });
}

// Deletions are kept as tombstones so they win over stale copies on other devices.
export function removeEntry(data, gameId, day, now = new Date()) {
  const d = normalize(data);
  const key = `${gameId}|${day}`;
  const tomb = { gameId, day, deleted: true, updatedAt: stampAfter(d.entries.find((e) => entryKey(e) === key), now) };
  return canonical({
    ...d,
    entries: [...d.entries.filter((e) => entryKey(e) !== key), tomb],
  });
}

export function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'game'
  );
}

export function upsertGame(data, game, now = new Date()) {
  const d = normalize(data);
  let id = game.id;
  if (!id) {
    const base = slugify(game.name);
    id = base;
    for (let i = 2; d.games.some((g) => g.id === id); i++) id = `${base}-${i}`;
  }
  const existing = d.games.find((g) => g.id === id);
  const order = game.order ?? existing?.order ?? Math.max(-1, ...d.games.map((g) => g.order ?? 0)) + 1;
  const next = { ...existing, ...game, id, order, updatedAt: stampAfter(existing, now) };
  if (!existing && !next.addedOn) next.addedOn = toDay(now);
  return canonical({ ...d, games: [...d.games.filter((g) => g.id !== id), next] });
}

export function formatScore(game, entry) {
  if (!entry || entry.score === null || entry.score === undefined || entry.score === '') return '';
  const max = game?.score?.max;
  const label = game?.score?.label || '';
  if (max) return `${entry.score}/${max}`;
  return label ? `${entry.score} ${label}` : String(entry.score);
}
