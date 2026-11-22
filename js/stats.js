import { addDays, diffDays } from './dates.js';
import { activeGames, liveEntries } from './model.js';

function streakEndingAt(daySet, endDay) {
  let n = 0;
  for (let d = endDay; daySet.has(d); d = addDays(d, -1)) n++;
  return n;
}

function longestRun(sortedDays) {
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of sortedDays) {
    run = prev && diffDays(d, prev) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

// Today not played yet doesn't break the streak; it's just "at risk".
function currentStreak(daySet, todayDay) {
  if (daySet.has(todayDay)) return { current: streakEndingAt(daySet, todayDay), atRisk: false };
  const current = streakEndingAt(daySet, addDays(todayDay, -1));
  return { current, atRisk: current > 0 };
}

export function gameStats(data, gameId, todayDay) {
  const entries = liveEntries(data)
    .filter((e) => e.gameId === gameId && e.day <= todayDay)
    .sort((a, b) => a.day.localeCompare(b.day));
  const days = [...new Set(entries.map((e) => e.day))];
  const daySet = new Set(days);
  const scores = entries.map((e) => e.score).filter((s) => typeof s === 'number' && Number.isFinite(s));
  const { current, atRisk } = currentStreak(daySet, todayDay);
  return {
    current,
    atRisk,
    longest: longestRun(days),
    total: days.length,
    doneToday: daySet.has(todayDay),
    firstDay: days[0] || null,
    average: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    best: scores.length ? Math.max(...scores) : null,
    byDay: new Map(entries.map((e) => [e.day, e])),
  };
}

// A day counts for the all-dailies streak when every game that existed that day was done,
// so adding a new game doesn't wipe out the existing streak.
export function overallStats(data, todayDay) {
  const games = activeGames(data);
  const ids = new Set(games.map((g) => g.id));
  const perDay = new Map();
  for (const e of liveEntries(data)) {
    if (!ids.has(e.gameId) || e.day > todayDay) continue;
    if (!perDay.has(e.day)) perDay.set(e.day, new Set());
    perDay.get(e.day).add(e.gameId);
  }
  const requiredOn = (day) => games.filter((g) => !g.addedOn || g.addedOn <= day);
  const allDays = [...perDay.entries()]
    .filter(([day, set]) => {
      const req = requiredOn(day);
      return req.length > 0 && req.every((g) => set.has(g.id));
    })
    .map(([d]) => d)
    .sort();
  const allSet = new Set(allDays);
  const { current, atRisk } = currentStreak(allSet, todayDay);
  return {
    gameCount: games.length,
    doneToday: perDay.get(todayDay)?.size || 0,
    allCurrent: current,
    allAtRisk: atRisk,
    allLongest: longestRun(allDays),
    daysPlayed: perDay.size,
  };
}
