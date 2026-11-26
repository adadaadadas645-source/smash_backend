import { col, db, Timestamp } from '../firebase';
import { AVATARS, FRAMES } from './profile';
import { hash } from './tournamentRules';
import { CREST_COUNT, MAX_MEMBERS } from './teamService';

/**
 * Sample teams for launch, so the team boards are not empty: per country a set of teams with
 * names that fit the place, some full (no one can join), some with a few members, their members
 * at ordinary levels. Every document is marked `seed: true` (ids seed_…), the same each time it
 * runs (deterministic), and all of it goes with `remove()`.
 *
 * Members are team members only (kingdom_team_members): no player, no leaderboard row, so the
 * player boards stay real players.
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
          const fn = pick(c.first, h(`f${m}`));
          const ln = pick(c.last, h(`l${m}`));
          // Some players as "Alex Smith", some as "Alex S." or "Alex23", as people name themselves.
          const style = hash(`${memberId}|style`) % 3;
          const display = (style === 0 ? `${fn} ${ln}` : style === 1 ? `${fn} ${ln[0]}.` : `${fn}${10 + (hash(`${memberId}|n`) % 90)}`).slice(0, 16);
          writes.push({
            ref: col.teamMembers().doc(memberId),
            data: {
              teamId,
              role: m === 0 ? 'leader' : m <= 2 && size > 6 ? 'coleader' : 'knight',
              level,
              helps: hash(`${memberId}|helps`) % 40,
              name: display,
              avatar: pick(AVATARS, hash(`${memberId}|av`)),
              frame: pick(FRAMES, hash(`${memberId}|fr`)),
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
    return { countries: COUNTRIES.length, teams, members };
  },

  /** Takes every sample team and member away (only those marked seed). */
  async remove(): Promise<{ teams: number; members: number }> {
    const [t, m] = await Promise.all([col.teams().where('seed', '==', true).get(), col.teamMembers().where('seed', '==', true).get()]);
    const refs = [...t.docs, ...m.docs].map((d) => d.ref);
    for (let i = 0; i < refs.length; i += 450) {
      const batch = db.batch();
      for (const r of refs.slice(i, i + 450)) batch.delete(r);
      await batch.commit();
    }
    return { teams: t.size, members: m.size };
  },

  /** The name search's lowercase name on every leaderboard row that lacks it (rows from before it came). */
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
      for (const d of snap.docs) {
        const name = d.get('name') as string | undefined;
        if (name && d.get('nameLower') !== name.toLocaleLowerCase('tr')) {
          batch.update(d.ref, { nameLower: name.toLocaleLowerCase('tr') });
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
