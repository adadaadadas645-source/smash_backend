import { col, db, Timestamp } from '../firebase';
import { AVATARS, FRAMES } from './profile';
import { hash } from './tournamentRules';
import { CREST_COUNT, MAX_MEMBERS } from './teamService';
import { leaderboardService } from './leaderboardService';

/**
 * Sample teams for launch, so the team boards are not empty: per country a set of teams with
 * names that fit the place, some full (no one can join), some with a few members, their members
 * at ordinary levels. Every document is marked `seed: true` (ids seed_…), the same each time it
 * runs (deterministic), and all of it goes with `remove()`.
 *
 * Each member is a team member (kingdom_team_members) and a row on the player boards
 * (kingdom_leaderboard, with the team's country), so someone looking a team's player up finds them
 * on the world and the country board. No player document: nothing that signs in or plays. Real
 * players' documents are never written; remove() takes only what is marked seed.
 */
type CountrySpec = { cc: string; teams: string[]; first: string[]; last: string[]; descriptions: string[] };

const FULL = MAX_MEMBERS;
/** The sizes of a country's teams, in order: 20 teams = 10 full, 5 of five, 5 of seven to nine. */
const sizesFor = (n: number): number[] => {
  if (n >= 20) return [...Array(10).fill(FULL), ...Array(5).fill(5), 7, 8, 9, 7, 8];
  if (n >= 10) return [...Array(4).fill(FULL), 5, 5, 5, 8, 9, 7];
  if (n >= 8) return [FULL, FULL, FULL, 5, 5, 7, 9, 8];
  return [FULL, FULL, 5, 5, 8, 7].slice(0, n);
};

const COUNTRIES: CountrySpec[] = [
  {
    cc: 'US',
    teams: [
      'Lone Star Legends', 'Brooklyn Bombers', 'Golden Gate Knights', 'Windy City Crew', 'Bay Area Blasters',
      'Texas Thunder', 'Miami Heatwave', 'Rocky Mountain Rams', 'Liberty Lions', 'Seattle Storm',
      'Big Apple Smashers', 'Desert Eagles', 'Motor City Mavericks', 'Boston Brawlers', 'Cali Cannons',
      'Dixie Dragons', 'Hudson Hawks', 'Vegas Vipers', 'Peach State Pirates', 'Empire Builders',
    ],
    first: ['Alex', 'Jake', 'Emily', 'Chris', 'Sarah', 'Mike', 'Ashley', 'Tyler', 'Jessica', 'Ryan', 'Megan', 'Josh', 'Lauren', 'Kevin', 'Hannah', 'Brandon', 'Olivia', 'Justin', 'Madison', 'Ethan', 'Ava', 'Noah', 'Chloe', 'Mason', 'Grace', 'Logan', 'Zoe', 'Dylan', 'Lily', 'Austin'],
    last: ['Smith', 'Johnson', 'Miller', 'Davis', 'Brown', 'Wilson', 'Moore', 'Taylor', 'Clark', 'Lewis', 'Walker', 'Hall', 'Young', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Adams', 'Carter'],
    descriptions: ['Smash hard, play fair!', 'Daily players welcome', 'We help each other with lives', 'Chill team, all levels', 'Active every day!', 'Top 10 is the goal'],
  },
  {
    cc: 'TR',
    teams: [
      'Anadolu Kartalları', 'İstanbul Fatihleri', 'Ege Rüzgarı', 'Karadeniz Fırtınası', 'Ankara Aslanları',
      'Kapadokya Şövalyeleri', 'Boğaz Korsanları', 'Toros Kaplanları', 'Akdeniz Yıldızları', 'İzmir Ateşi',
      'Bursa Kalesi', 'Trakya Savaşçıları', 'Van Gölü Ekibi', 'Fırat Kahramanları', 'Antalya Güneşi',
      'Konya Kervanı', 'Erciyes Zirvesi', 'Mezopotamya Krallığı', 'Kıyı Kalesi', 'Sultan Ordusu',
    ],
    first: ['Ahmet', 'Mehmet', 'Ayşe', 'Fatma', 'Emre', 'Elif', 'Burak', 'Zeynep', 'Can', 'Merve', 'Murat', 'Selin', 'Kerem', 'Ece', 'Oğuz', 'Deniz', 'Cem', 'Esra', 'Barış', 'Büşra', 'Arda', 'Damla', 'Onur', 'Gizem', 'Serkan', 'Ceren', 'Kaan', 'İrem', 'Tolga', 'Buse'],
    last: ['Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Yıldız', 'Arslan', 'Aydın', 'Öztürk', 'Doğan', 'Kılıç', 'Koç', 'Kurt', 'Polat', 'Erdem', 'Aksoy', 'Tekin', 'Güneş', 'Özdemir', 'Bulut'],
    descriptions: ['Her gün aktif, can yardımı var!', 'Herkese açık, keyifli takım', 'Haftalık yarışta zirveye!', 'Yardımlaşan dostlar', 'Seviye fark etmez, gel!', 'Sohbet ve oyun bir arada'],
  },
  {
    cc: 'DE',
    teams: ['Berliner Bären', 'Münchner Löwen', 'Hamburger Hafenhelden', 'Kölner Kanonen', 'Schwarzwald Ritter', 'Rhein Riesen', 'Alpen Adler', 'Frankfurter Falken', 'Sachsen Stürmer', 'Bayern Burg'],
    first: ['Lukas', 'Leon', 'Anna', 'Laura', 'Finn', 'Lena', 'Jonas', 'Mia', 'Paul', 'Lea', 'Felix', 'Sophie', 'Max', 'Hannah', 'Tim', 'Julia', 'Elias', 'Emma', 'Noah', 'Marie'],
    last: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Hoffmann', 'Koch'],
    descriptions: ['Jeden Tag dabei!', 'Freundliches Team für alle', 'Wir helfen mit Leben', 'Gemeinsam nach oben'],
  },
  {
    cc: 'GB',
    teams: ['London Lancers', 'Manchester Mighty', 'Thames Raiders', 'Highland Clan', 'Cotswold Crown', 'Liverpool Lions', 'Yorkshire Yeomen', 'Camelot Knights'],
    first: ['Oliver', 'Harry', 'Amelia', 'Isla', 'George', 'Poppy', 'Jack', 'Freya', 'Charlie', 'Evie', 'Alfie', 'Millie', 'Archie', 'Rosie', 'Henry', 'Ella'],
    last: ['Jones', 'Evans', 'Roberts', 'Hughes', 'Edwards', 'Thomas', 'Wood', 'Turner', 'Hill', 'Ward'],
    descriptions: ['Cheers and smash!', 'Friendly crew, all welcome', 'Lives sent daily', 'For king and crown'],
  },
  {
    cc: 'FR',
    teams: ['Les Mousquetaires', 'Paris Paladins', 'Lyon Lions', 'Côte d’Azur Crew', 'Normandie Knights', 'Bordeaux Barons'],
    first: ['Lucas', 'Hugo', 'Chloé', 'Inès', 'Louis', 'Manon', 'Jules', 'Camille', 'Gabriel', 'Léa', 'Arthur', 'Zoé'],
    last: ['Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau'],
    descriptions: ['Tous pour un !', 'Équipe sympa et active', 'On s’entraide', 'Bienvenue à tous'],
  },
  {
    cc: 'BR',
    teams: ['Samba Smashers', 'Rio Raiders', 'Amazônia Guerreiros', 'São Paulo Sultans', 'Copacabana Crew', 'Bahia Bravos'],
    first: ['Gabriel', 'Lucas', 'Ana', 'Julia', 'Pedro', 'Beatriz', 'Mateus', 'Larissa', 'Rafael', 'Camila', 'Felipe', 'Mariana'],
    last: ['Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Costa', 'Pereira', 'Almeida', 'Rocha', 'Ribeiro'],
    descriptions: ['Bora jogar todo dia!', 'Time animado e amigo', 'Ajudamos com vidas', 'Rumo ao topo!'],
  },
];

const pick = <T>(list: readonly T[], k: number) => list[k % list.length];

export type SeedReport = { countries: number; teams: number; members: number };

export const seedService = {
  /** Writes (or rewrites, the same) every sample team and its members. */
  async plant(): Promise<SeedReport> {
    const writes: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
    const now = Date.now();
    let teams = 0;
    let members = 0;
    for (const c of COUNTRIES) {
      // Every name once in a country (two "Sarah Adams" in one team would give it away).
      const taken = new Set<string>();
      const sizes = sizesFor(c.teams.length);
      c.teams.forEach((name, t) => {
        const teamId = `seed_${c.cc.toLowerCase()}_${t}`;
        const size = sizes[t] ?? 6;
        const h = (k: string) => hash(`${teamId}|${k}`);
        // Levels like real players: the leader a little ahead, nobody very high.
        const levelOf = (m: number) => 15 + (hash(`${teamId}|lvl|${m}`) % (m === 0 ? 380 : 300));
        const minLevel = size === FULL ? pick([0, 10, 20, 30, 50], h('min')) : pick([0, 0, 5, 10], h('min'));
        let score = 0;
        for (let m = 0; m < size; m++) {
          const memberId = `${teamId}_m${m}`;
          const level = levelOf(m);
          score += level;
          let fn = pick(c.first, h(`f${m}`));
          let ln = pick(c.last, h(`l${m}`));
          // Some players as "Alex Smith", some as "Alex S." or "Alex23", as people name themselves.
          const style = hash(`${memberId}|style`) % 3;
          const make = (k: number) =>
            (style === 0 ? `${fn} ${ln}` : style === 1 ? `${fn} ${ln[0]}.` : `${fn}${10 + ((hash(`${memberId}|n`) + k) % 90)}`).slice(0, 16);
          let display = make(0);
          for (let k = 1; taken.has(display.toLocaleLowerCase('tr')) && k < 400; k++) {
            // Another first and last name (or number) until it is new here.
            fn = pick(c.first, h(`f${m}`) + k);
            ln = pick(c.last, h(`l${m}`) + Math.floor(k / c.first.length) + k);
            display = make(k);
          }
          if (taken.has(display.toLocaleLowerCase('tr'))) display = `${fn}${100 + (hash(memberId) % 900)}`.slice(0, 16);
          taken.add(display.toLocaleLowerCase('tr'));
          const avatar = pick(AVATARS, hash(`${memberId}|av`));
          const frame = pick(FRAMES, hash(`${memberId}|fr`));
          const stats = {
            firstTry: Math.round(level * (0.25 + (hash(`${memberId}|ft`) % 30) / 100)),
            bestStreak: 3 + (hash(`${memberId}|bs`) % Math.max(4, Math.round(level / 12))),
            eventWins: hash(`${memberId}|ev`) % Math.max(2, Math.round(level / 40)),
          };
          const reachedAt = Timestamp.fromMillis(now - (hash(`${memberId}|reach`) % (3 * 86400)) * 1000);
          writes.push({
            ref: col.leaderboard().doc(memberId),
            data: {
              playerId: memberId, name: display, nameLower: display.toLocaleLowerCase('tr'), avatar, frame, level, stats,
              team: name, country: c.cc, levelReachedAt: reachedAt, updatedAt: reachedAt, seed: true,
            },
          });
          writes.push({
            ref: col.teamMembers().doc(memberId),
            data: {
              teamId,
              role: m === 0 ? 'leader' : m <= 2 && size > 6 ? 'coleader' : 'knight',
              level,
              helps: hash(`${memberId}|helps`) % 40,
              // First-try wins, longest streak, event wins: about what a player at that level has.
              stats,
              name: display,
              avatar,
              frame,
              joinedAt: Timestamp.fromMillis(now - (hash(`${memberId}|age`) % (60 * 86400)) * 1000),
              seed: true,
            },
          });
          members++;
        }
        // Active within the last two days (High / Medium on their page).
        const activeAt = Timestamp.fromMillis(now - (h('act') % (2 * 86400)) * 1000);
        writes.push({
          ref: col.teams().doc(teamId),
          data: {
            name,
            nameLower: name.toLocaleLowerCase('tr'),
            description: pick(c.descriptions, h('desc')),
            crest: h('crest') % CREST_COUNT,
            type: size === FULL ? pick(['open', 'request'], h('type')) : 'open',
            minLevel,
            minCrowns: 0,
            members: size,
            score,
            leaderId: `${teamId}_m0`,
            country: c.cc,
            createdAt: Timestamp.fromMillis(now - (40 + (h('born') % 120)) * 86400_000),
            activeAt,
            seed: true,
          },
        });
        teams++;
      });
    }
    for (let i = 0; i < writes.length; i += 450) {
      const batch = db.batch();
      for (const w of writes.slice(i, i + 450)) batch.set(w.ref, w.data);
      await batch.commit();
    }
    leaderboardService.forgetCaches();
    return { countries: COUNTRIES.length, teams, members };
  },

  /** Takes every sample team and member away (only those marked seed). */
  async remove(): Promise<{ teams: number; members: number; boardRows: number }> {
    const [t, m, b] = await Promise.all([
      col.teams().where('seed', '==', true).get(),
      col.teamMembers().where('seed', '==', true).get(),
      col.leaderboard().where('seed', '==', true).get(),
    ]);
    // Only ids made here (seed_…): a real player's document is never in it, whatever it holds.
    const refs = [...t.docs, ...m.docs, ...b.docs].filter((d) => d.id.startsWith('seed_')).map((d) => d.ref);
    for (let i = 0; i < refs.length; i += 450) {
      const batch = db.batch();
      for (const r of refs.slice(i, i + 450)) batch.delete(r);
      await batch.commit();
    }
    leaderboardService.forgetCaches();
    return { teams: t.size, members: m.size, boardRows: b.size };
  },

  /** Every leaderboard row's name as the player has it now, and its lowercase for the name search. */
  async backfillNames(): Promise<{ updated: number }> {
    let updated = 0;
    let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let q = col.leaderboard().orderBy('__name__').limit(400);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      const batch = db.batch();
      let n = 0;
      // The player's own name now (a name changed, or an account made, after their last level).
      const real = snap.docs.filter((d) => !d.id.startsWith('seed_'));
      const players = real.length ? await db.getAll(...real.map((d) => col.players().doc(d.id))) : [];
      const nameNow = new Map(players.filter((p) => p.exists && typeof p.get('name') === 'string').map((p) => [p.id, p.get('name') as string]));
      for (const d of snap.docs) {
        const name = nameNow.get(d.id) ?? (d.get('name') as string | undefined);
        if (name && (d.get('name') !== name || d.get('nameLower') !== name.toLocaleLowerCase('tr'))) {
          batch.update(d.ref, { name, nameLower: name.toLocaleLowerCase('tr') });
          n++;
        }
      }
      if (n) await batch.commit();
      updated += n;
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < 400) break;
    }
    return { updated };
  },
};
