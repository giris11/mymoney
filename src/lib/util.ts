import dayjs from 'dayjs';

/** New record id. */
export const uid = (): string => crypto.randomUUID();

export const nowISO = (): string => new Date().toISOString();

/** Today as a 'YYYY-MM-DD' calendar date in the device's timezone. */
export const todayISO = (): string => dayjs().format('YYYY-MM-DD');

/** Display a 'YYYY-MM-DD' date the en-GB way. */
export const formatDate = (isoDate: string): string => dayjs(isoDate).format('DD/MM/YYYY');

/** join class names, skipping falsy */
export const cn = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(' ');

/** Case/whitespace-insensitive key for name lookups (payees, tags, accounts). */
export const nameKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
