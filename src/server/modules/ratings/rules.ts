export const STARS = [1, 2, 3, 4, 5] as const;
export type Stars = (typeof STARS)[number];

export const NOTE_MAX = 280;
export const WINDOW_DAYS = 7;
export const MIN_SESSIONS = 10;
export const MIN_RATINGS = 5;

export type PublicRating = { average: string; count: number };

export function publicRating(sum: number, count: number, sessions: number): PublicRating | null {
  if (sessions < MIN_SESSIONS || count < MIN_RATINGS) return null;
  return { average: (Math.round((sum * 10) / count) / 10).toFixed(1), count };
}
