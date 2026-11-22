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
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

// The workflow passes the cron line that fired; fall back to the local hour for manual runs.
export function slotFor(schedule, hour) {
  const m = /^\s*\S+\s+(\d+)\s/.exec(schedule || '');
  const h = m ? Number(m[1]) : hour;
  return h < 15 ? 'morning' : 'evening';
}

export function buildReminder(data, { now = new Date(), tz, trackerUrl, schedule, test = false }) {
  const { day, hour } = localParts(now, tz);
  const slot = slotFor(schedule, hour);
  // A badly delayed run shouldn't nag about the wrong part of the day (or the next day).
  if (!test && schedule && (slot === 'evening' ? hour < 15 : hour >= 15)) return null;

  const d = withDefaults(normalize(data));
  const pending = activeGames(d)
    .filter((g) => !findEntry(d, g.id, day))
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
      title: 'Dailies reminders are working ✅',
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

export async function sendNtfy(msg, { server = 'https://ntfy.sh', topic, token, fetchImpl = fetch }) {
  const res = await fetchImpl(server.replace(/\/+$/, '') + '/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ topic, ...msg }),
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}: ${await res.text()}`);
}

async function main(env = process.env) {
  const topic = env.NTFY_TOPIC;
  if (!topic) throw new Error('NTFY_TOPIC is not set (add it as a repository secret).');
  const tz = env.REMINDER_TZ || 'America/Los_Angeles';
  let data = {};
  try {
    data = JSON.parse(await readFile(env.DATA_FILE || 'data.json', 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const msg = buildReminder(data, {
    tz,
    trackerUrl: env.TRACKER_URL,
    schedule: env.SCHEDULE,
    test: env.TEST === 'true',
  });
  if (!msg) {
    console.log('Nothing to remind about.');
    return;
  }
  await sendNtfy(msg, { server: env.NTFY_SERVER || undefined, topic, token: env.NTFY_TOKEN || undefined });
  console.log(`Sent: ${msg.title}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
