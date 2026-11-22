// Day strings are 'YYYY-MM-DD' in the user's local timezone.

const pad = (n) => String(n).padStart(2, '0');

export function toDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function today() {
  return toDay(new Date());
}

// Pure calendar arithmetic in UTC so DST never shifts a day.
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function diffDays(a, b) {
  const toUtc = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(a) - toUtc(b)) / 86400000);
}

export function dayRange(endDay, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(addDays(endDay, -i));
  return out;
}

export function formatDay(day, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}
