// Daily reminder: reads data.json and, if any active game isn't done today, pushes an ntfy notification.
// Runs in GitHub Actions in the private data repo (see reminders/reminders.yml).
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { activeGames, findEntry, normalize, withDefaults } from '../js/model.js';
import { gameStats } from '../js/stats.js';

export function localParts(now, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// GitHub's scheduler can run hours late, so the workflow polls often and the script decides
// whether we're inside a reminder window. Each slot fires at most once (see alreadySent).
export const SLOTS = {
  morning: { start: 8 * 60 + 30, end: 15 * 60 },
  evening: { start: 20 * 60 + 30, end: 24 * 60 },
};

export function currentSlot(now, tz) {
  const { hour, minute } = localParts(now, tz);
  const m = hour * 60 + minute;
  for (const [name, w] of Object.entries(SLOTS)) if (m >= w.start && m < w.end) return name;
  return null;
}

export function slotStartEpoch(now, tz, slot) {
  const { hour, minute, second } = localParts(now, tz);
  const sinceStartSec = (hour * 60 + minute - SLOTS[slot].start) * 60 + second;
  return Math.floor(now.getTime() / 1000) - sinceStartSec;
}

const TEST_TITLE = 'Dailies reminders are working ✅';

export function buildReminder(data, { now = new Date(), tz, trackerUrl, slot, test = false }) {
  const { day } = localParts(now, tz);
  if (!test && !slot) return null;

  const d = withDefaults(normalize(data));
  const pending = activeGames(d)
    .filter((g) => (!g.addedOn || g.addedOn <= day) && !findEntry(d, g.id, day))
    .map((g) => ({ game: g, streak: gameStats(d, g.id, day).current }));

  if (!pending.length && !test) return null;

  const lines = pending.map(({ game, streak }) => `${game.emoji || '🎮'} ${game.name}${streak ? ` · 🔥${streak} at risk` : ''}`);
  const msg = {
    ...(trackerUrl ? { click: trackerUrl } : {}),
    actions: pending.slice(0, 3).map(({ game }) => ({ action: 'view', label: `Play ${game.name}`, url: game.url, clear: true })),
  };
  if (test) {
    return {
      ...msg,
      title: TEST_TITLE,
      message: pending.length ? `Still to play today:\n${lines.join('\n')}` : 'Everything is done today. Nice!',
      tags: ['white_check_mark'],
      priority: 3,
    };
  }
  if (slot === 'morning') {
    return {
      ...msg,
      title: `Today's dailies (${pending.length})`,
      message: lines.join('\n'),
      tags: ['sunny'],
      priority: 3,
    };
  }
  return {
    ...msg,
    title: `Still to play: ${pending.map((p) => p.game.name).join(', ')}`,
    message: `${lines.join('\n')}\nPlay before midnight to keep your streak.`,
    tags: ['alarm_clock'],
    priority: 4,
  };
}

const ntfyBase = (server) => (server || 'https://ntfy.sh').replace(/\/+$/, '');
const authHeader = (token) => (token ? { Authorization: `Bearer ${token}` } : {});

export async function sendNtfy(msg, { server, topic, token, fetchImpl = fetch }) {
  const res = await fetchImpl(ntfyBase(server) + '/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(token) },
    body: JSON.stringify({ topic, ...msg }),
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}: ${await res.text()}`);
}

// The topic doubles as our "already sent" log, so no state needs committing anywhere.
export async function alreadySent({ server, topic, token, since, fetchImpl = fetch }) {
  const url = `${ntfyBase(server)}/${encodeURIComponent(topic)}/json?poll=1&since=${since}`;
  const res = await fetchImpl(url, { headers: authHeader(token) });
  if (!res.ok) throw new Error(`ntfy poll responded ${res.status}: ${await res.text()}`);
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .some((m) => m.event === 'message' && m.title !== TEST_TITLE);
}

export async function run(env = process.env, { now = new Date(), fetchImpl = fetch, log = console.log } = {}) {
  const topic = env.NTFY_TOPIC;
  if (!topic) throw new Error('NTFY_TOPIC is not set (add it as a repository secret).');
  const tz = env.REMINDER_TZ || 'America/Los_Angeles';
  const test = env.TEST === 'true';
  const slot = currentSlot(now, tz);
  if (!test && !slot) {
    const { hour, minute } = localParts(now, tz);
    log(`Outside reminder windows (${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${tz}).`);
    return null;
  }
  let data = {};
  try {
    data = JSON.parse(await readFile(env.DATA_FILE || 'data.json', 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const msg = buildReminder(data, { now, tz, trackerUrl: env.TRACKER_URL, slot, test });
  if (!msg) {
    log(`Nothing to remind about (${slot}).`);
    return null;
  }
  const ntfy = { server: env.NTFY_SERVER || undefined, topic, token: env.NTFY_TOKEN || undefined, fetchImpl };
  if (!test && (await alreadySent({ ...ntfy, since: slotStartEpoch(now, tz, slot) }))) {
    log(`The ${slot} reminder was already sent today.`);
    return null;
  }
  await sendNtfy(msg, ntfy);
  log(`Sent (${test ? 'test' : slot}): ${msg.title}`);
  return msg;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
