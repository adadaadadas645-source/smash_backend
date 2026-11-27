/**
 * The team chat's text: cleaned as names are (no control or bidi characters, no markup), at most
 * MAX_CHARS, and its rude words masked with stars ("s***"). Links are not allowed (a chat with
 * links is a spam channel): they are masked too. Kept simple and conservative: a word is masked
 * when it starts with one of the roots below, so suffixes ("-ler", "-ing") are caught.
 */
export const MAX_CHARS = 200;

// Turkish and English roots, lower case, without diacritics (the text is folded before the check).
const ROOTS = [
  'amk', 'amina', 'aminak', 'amcik', 'orospu', 'orosbu', 'pic', 'pezevenk', 'yarak', 'yarra', 'sik', 'sikis',
  'got', 'gotveren', 'ibne', 'kahpe', 'yavsak', 'serefsiz', 'siktir', 'oc', 'mal', 'gerizekali', 'aptal',
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'asshole', 'bastard', 'slut', 'whore', 'nigger', 'faggot', 'retard',
];

// Words that start like a root but are fine (Turkish): "malzeme", "sikayet", "gotur", "picnic"...
const ALLOWED = ['malzeme', 'mali', 'malik', 'mallar', 'sikayet', 'sikinti', 'siki', 'gotur', 'gotik', 'picnic', 'ocak', 'ocean', 'dickens', 'cocktail', 'class', 'assist', 'aptallik'];

function fold(word: string): string {
  return word
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/\$/g, 's').replace(/@/g, 'a')
    .replace(/[^a-z]/g, '');
}

export function isRude(word: string): boolean {
  const f = fold(word);
  if (f.length < 2) return false;
  if (ALLOWED.some((a) => f.startsWith(a))) return false;
  // Short roots ("oc", "mal", "got", "pic", "sik") only as the whole word or with a few letters more.
  return ROOTS.some((r) => (r.length <= 3 ? f === r || (f.startsWith(r) && f.length <= r.length + 3) : f.startsWith(r)));
}

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|gg|tr|me|ly|xyz|app)\b)/i;

function mask(word: string): string {
  const chars = [...word];
  return chars.length <= 1 ? '*' : chars[0] + '*'.repeat(chars.length - 1);
}

/**
 * Personal information a child should not share in chat: email addresses, phone numbers (seven
 * digits or more, spaces and dashes between them allowed), @handles, and the apps people move a
 * talk to ("insta", "discord", "snap", "whatsapp", "telegram", "tiktok"…). Each found is hidden.
 */
const EMAIL = /[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/gu;
const PHONE = /(?:\+?\d[\s\-().]*){7,}/g;
const HANDLE = /(^|\s)@[\p{L}0-9._]{2,}/gu;
const APPS = /\b(insta(gram)?|ig|discord|snap(chat)?|whats?app|telegram|tiktok|facebook|fb|twitter|kik|wechat|line ?id)\b/giu;

export function hidePersonal(s: string): string {
  return s
    .replace(EMAIL, (m) => '*'.repeat(Math.min(m.length, 8)))
    .replace(PHONE, (m) => m.replace(/\d/g, '*'))
    .replace(HANDLE, (_m, lead: string) => `${lead}@***`)
    .replace(APPS, (m) => '*'.repeat(m.length));
}

/** True when a name (a player's, a team's) holds a rude word anywhere in it, or personal information. */
export function nameIsRude(raw: string): boolean {
  const s = String(raw ?? '');
  if (hidePersonal(s) !== s) return true;
  // Its words: by spaces, dots, dashes, underscores and capital letters ("SikAdam" -> "Sik", "Adam").
  const words = s.replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2').split(/[\s._\-]+/).filter(Boolean);
  if (words.some((w) => isRude(w))) return true;
  if (words.some((w) => /^(insta(gram)?|ig|discord|snap(chat)?|whats?app|telegram|tiktok|facebook|fb|twitter|kik|wechat)$/i.test(w))) return true;
  // Glued together ("SikAdam", "fuckyou"): the whole name folded, looked at from each letter.
  const folded = s
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/\$/g, 's').replace(/@/g, 'a')
    .replace(/[^a-z]/g, '');
  return LONG_ROOTS.some((r) => folded.includes(r));
}

/** Roots long enough to look for inside a word (short ones like "mal" would catch "Kemal"). */
const LONG_ROOTS = ['amina', 'amcik', 'orospu', 'orosbu', 'pezevenk', 'yarak', 'yarra', 'siktir', 'sikis', 'gotveren', 'ibne', 'kahpe', 'yavsak', 'serefsiz', 'gerizekali', 'fuck', 'shit', 'bitch', 'cunt', 'pussy', 'asshole', 'bastard', 'slut', 'whore', 'nigger', 'faggot', 'retard'];

export function cleanMessage(raw: unknown): string {
  let s = typeof raw === 'string' ? raw : '';
  s = s.normalize('NFKC');
  s = s.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿<>]/g, '');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if ([...s].length > MAX_CHARS) s = [...s].slice(0, MAX_CHARS).join('').trim();
  s = hidePersonal(s);
  return s
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) ? part : LINK.test(part) || isRude(part) ? mask(part) : part))
    .join('');
}
