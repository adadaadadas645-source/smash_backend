import { z } from 'zod';

/** The same lists as HomeUi.AvatarIds / FrameIds in the game. */
export const AVATARS = ['leo', 'bruno', 'max', 'bella', 'jax', 'goldie', 'wizard', 'princess', 'parrot', 'pumpkin'] as const;
export const FRAMES = ['gold', 'purple', 'blue'] as const;

/**
 * A name as the leaderboard shows it: control characters, zero-width and bidi marks and markup
 * out, spaces collapsed, at most 16 characters (the game's own limit). Empty after that:
 * a generated "Oyuncu1234"-style name.
 */
export function cleanName(raw: unknown): string {
  let s = typeof raw === 'string' ? raw : '';
  s = s.normalize('NFKC');
  s = s.replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿<>]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if ([...s].length > 16) s = [...s].slice(0, 16).join('').trim();
  if (s.length === 0) s = `Oyuncu${1000 + Math.floor(Math.random() * 9000)}`;
  return s;
}

export const profileSchema = z.object({
  name: z.string().max(64).optional().transform((v) => (v === undefined ? undefined : cleanName(v))),
  avatar: z.enum(AVATARS).optional().catch(undefined),
  frame: z.enum(FRAMES).optional().catch(undefined),
  locale: z.string().max(10).regex(/^[A-Za-z-]+$/).optional().catch(undefined),
});

export type ProfileInput = z.infer<typeof profileSchema>;
