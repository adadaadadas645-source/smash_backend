/**
 * The Arrow Tournament's rules, apart from the database so they can be tested on their own.
 *
 * Windows: TOURNAMENT_SLOTS_UTC ("10:00,16:00,19:00": 13:00, 19:00, 22:00 in Turkey) each day,
 * TOURNAMENT_MINUTES (30) long. TOURNAMENT_ALWAYS=1 (testing): a window every half hour, round
 * the clock. A window's id is its start, "2026-11-25T10:00Z".
 *
 * Groups: five players. While there are not enough real players the empty places are bots,
 * the same on every phone and here (their names, faces and points come from the window, the
 * group and the place), collecting points at their own pace through the window.
 */

export const GROUP_SIZE = 5;
/** The most one level may add (a level won with every shot left over is well under this). */
export const MAX_ADD = 250;
/** The least time between two scores of one player (a level takes longer than this). */
export const MIN_GAP_MS = 12_000;
/** The most one player can have in a window. */
export const MAX_POINTS = 6000;
/** A level started before the end may still be counted this long after it. */
export const GRACE_MS = 3 * 60_000;
/** No one joins in the last minute. */
export const JOIN_CLOSES_MS = 60_000;

export type Window = { id: string; startsAt: number; endsAt: number };

export type TournamentPrize = { kind: 'coins' | 'booster' | 'hearts'; id?: string; n: number };

/** The prize: the 1st's only ("hearts": unlimited lives, n minutes). */
export const PRIZES: TournamentPrize[][] = [
  [
    { kind: 'coins', n: 500 },
    { kind: 'booster', id: 'bomb', n: 1 },
    { kind: 'booster', id: 'giant', n: 1 },
    { kind: 'hearts', n: 60 },
  ],
];

export function prizeFor(place: number): TournamentPrize[] | null {
  return place >= 1 && place <= PRIZES.length ? PRIZES[place - 1] : null;
}

export type Schedule = { slots: number[]; minutes: number; always: boolean };

/** "10:00,16:00,19:00" → minutes after midnight UTC, sorted; bad parts left out. */
export function parseSlots(raw: string | undefined): number[] {
  const out: number[] = [];
  for (const part of String(raw ?? '').split(',')) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) continue;
    out.push(h * 60 + min);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export function scheduleFromEnv(env: NodeJS.ProcessEnv = process.env): Schedule {
  const slots = parseSlots(env.TOURNAMENT_SLOTS_UTC ?? '10:00,16:00,19:00');
  const minutes = Math.min(180, Math.max(5, Number(env.TOURNAMENT_MINUTES) || 30));
  return { slots: slots.length ? slots : [600, 960, 1140], minutes, always: env.TOURNAMENT_ALWAYS === '1' };
}

const MINUTE = 60_000;
const DAY = 86_400_000;

function windowFrom(start: number, minutes: number): Window {
  return { id: new Date(start).toISOString().slice(0, 16) + 'Z', startsAt: start, endsAt: start + minutes * MINUTE };
}

/** The window open at `now`, or null. */
export function windowAt(now: number, s: Schedule): Window | null {
  if (s.always) {
    const step = s.minutes * MINUTE;
    return windowFrom(Math.floor(now / step) * step, s.minutes);
  }
  const day = Math.floor(now / DAY) * DAY;
  // Yesterday's last window may still run after midnight.
  for (const d of [day, day - DAY])
    for (const slot of s.slots) {
      const w = windowFrom(d + slot * MINUTE, s.minutes);
      if (now >= w.startsAt && now < w.endsAt) return w;
    }
  return null;
}

/** The next window to open after `now`. */
export function nextWindow(now: number, s: Schedule): Window {
  if (s.always) {
    const step = s.minutes * MINUTE;
    return windowFrom((Math.floor(now / step) + 1) * step, s.minutes);
  }
  const day = Math.floor(now / DAY) * DAY;
  for (const d of [day, day + DAY])
    for (const slot of s.slots) {
      const start = d + slot * MINUTE;
      if (start > now) return windowFrom(start, s.minutes);
    }
  return windowFrom(day + 2 * DAY + s.slots[0] * MINUTE, s.minutes);
}

/** A window from its id, or null when the id is not one (the schedule is not asked: an old one may have changed). */
export function windowOfId(id: string, s: Schedule): Window | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(id)) return null;
  const start = Date.parse(id.replace('Z', ':00Z'));
  return Number.isFinite(start) ? windowFrom(start, s.minutes) : null;
}

/** A small, steady hash of a string (FNV-1a), 0 .. 2^32-1. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const BOT_NAMES = [
  'Vic', 'Romy', 'BoBy', 'karma', 'Lina', 'Toprak', 'Mert', 'Ece', 'Duke', 'Robin', 'Zeyno', 'Kaan', 'Elif', 'Arda', 'Mia',
  'Leo42', 'Sir Bolt', 'Ayla', 'Deniz', 'Hugo', 'Nova', 'Can', 'Selin', 'Ozzy', 'Bella', 'Rüzgar', 'Ada', 'Tom', 'Yağız', 'Lara',
];
const BOT_AVATARS = ['leo', 'bruno', 'max', 'bella', 'jax', 'goldie', 'wizard', 'princess', 'parrot', 'pumpkin'];
const BOT_FRAMES = ['gold', 'purple', 'blue'];

export type Bot = { botId: string; name: string; avatar: string; frame: string; pace: number; perLevel: number; startDelay: number };

/** The bot at `place` (0..) of a group. */
export function botOf(windowId: string, group: number, place: number): Bot {
  const h = (k: string) => hash(`${windowId}|${group}|${place}|${k}`);
  return {
    botId: `bot_${hash(`${windowId}|${group}|${place}`).toString(36)}`,
    name: BOT_NAMES[h('name') % BOT_NAMES.length],
    avatar: BOT_AVATARS[h('avatar') % BOT_AVATARS.length],
    frame: BOT_FRAMES[h('frame') % BOT_FRAMES.length],
    // Seconds a level takes it, and what a level brings it: from a slow, careful player to a quick one.
    pace: 95 + (h('pace') % 110),
    perLevel: 28 + (h('per') % 34),
    startDelay: h('delay') % 240,
  };
}

/** A bot's points `at` a moment of the window: a level's worth each time it finishes one. */
export function botPoints(bot: Bot, w: Window, at: number): number {
  const t = (Math.min(at, w.endsAt) - w.startsAt) / 1000 - bot.startDelay;
  if (t <= 0) return 0;
  const levels = Math.floor(t / bot.pace);
  let sum = 0;
  for (let i = 0; i < levels; i++) {
    // Some levels go better than others (the same for everyone who looks).
    const swing = (hash(`${bot.botId}|${i}`) % 21) - 10;
    sum += Math.max(8, bot.perLevel + swing);
  }
  return sum;
}

export type Standing = { id: string; name: string; avatar: string; frame: string; points: number; joinedAt: number; bot: boolean };

/** Most points first; on a tie, who got there first (joined earlier). */
export function rank(rows: Standing[]): (Standing & { rank: number })[] {
  return [...rows].sort((a, b) => b.points - a.points || a.joinedAt - b.joinedAt).map((r, i) => ({ ...r, rank: i + 1 }));
}

/** What a score may add: null when it is refused, else the points actually taken (capped). */
export function allowedAdd(current: number, lastAt: number, add: number, now: number): number | null {
  if (!Number.isFinite(add) || add <= 0) return null;
  if (lastAt > 0 && now - lastAt < MIN_GAP_MS) return null;
  const capped = Math.min(Math.floor(add), MAX_ADD);
  return Math.max(0, Math.min(capped, MAX_POINTS - current));
}
