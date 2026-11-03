import { z } from 'zod';
import { isIsoDate } from './lib/dates.js';

// Zod schemas for every request body and for the date/id path params. Routes
// parse with these before touching the store; a ZodError becomes a 400 in
// errorHandler.

export const isoDate = z.string().refine(isIsoDate, 'expected a real YYYY-MM-DD date');

export const idParam = z.coerce.number().int().positive();

// ── Auth and settings (unchanged from the pre-rebuild API) ──────────────────

export const loginSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

export const securityVerifySchema = z
  .object({
    answer: z.string(),
  })
  .strict();

export const securityUpdateSchema = z
  .object({
    currentAnswer: z.string(),
    newAnswer: z.string().min(1).max(255),
  })
  .strict();

export const passwordUpdateSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(200),
  })
  .strict();

export const timezoneUpdateSchema = z
  .object({
    timezone: z.string().min(1).max(64),
  })
  .strict();

// ── Habits ──────────────────────────────────────────────────────────────────

const label = z.string().trim().min(1).max(80);

// Stored exactly as typed apart from surrounding whitespace. Blank means none.
const rampText = z
  .union([z.string(), z.null()])
  .transform((v) => (v === null ? null : v.trim() || null))
  .refine((v) => v === null || v.length <= 120, 'rampText is at most 120 characters');

export const habitCreateSchema = z
  .object({
    // The slug is the habit's stable external id (the widget and the importer
    // match on it), so it is set once here and PATCH cannot change it.
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'slug: lowercase letters, digits, hyphens'),
    label,
    sort: z.number().int().optional(),
    rampText: rampText.optional(),
  })
  .strict();

// A habit's schedule (src/lib/schedule.ts). Weekdays: 0 = Sunday … 6 =
// Saturday, at least one; duplicates are dropped and the list sorted.
export const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily') }).strict(),
  z.object({ kind: z.literal('every_other_day'), anchor: isoDate }).strict(),
  z
    .object({
      kind: z.literal('weekdays'),
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    })
    .strict(),
]);

export const habitPatchSchema = z
  .object({
    label: label.optional(),
    sort: z.number().int().optional(),
    rampText: rampText.optional(),
    retired: z.boolean().optional(),
    schedule: scheduleSchema.optional(),
    // The first day the new schedule applies: the client's today. Omitted =
    // today in app_timezone. Earlier days keep the schedule they had.
    scheduleFrom: isoDate.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change')
  .refine((v) => v.scheduleFrom === undefined || v.schedule !== undefined, 'scheduleFrom needs a schedule');

// ── Notes ───────────────────────────────────────────────────────────────────

export const NOTE_MAX = 280;

// One line: any run of line breaks becomes a single space. Empty after trimming
// means "delete the note", which the route handles.
export const noteSchema = z
  .object({
    line: z
      .string()
      .max(4000)
      .transform((s) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim())
      .refine((s) => s.length <= NOTE_MAX, `line is at most ${NOTE_MAX} characters`),
  })
  .strict();

// ── Learned ─────────────────────────────────────────────────────────────────

export const LEARNED_MAX = 500;

// "What new thing did I learn today?" One entry a day, folded to one line
// like a note; empty after trimming means "delete it".
export const learnedSchema = z
  .object({
    text: z
      .string()
      .max(4000)
      .transform((s) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim())
      .refine((s) => s.length <= LEARNED_MAX, `text is at most ${LEARNED_MAX} characters`),
  })
  .strict();

export const LEARNED_PAGE_MAX = 200;

export const learnedQuery = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(LEARNED_PAGE_MAX).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

// ── Import ──────────────────────────────────────────────────────────────────

// The Scriptable widget's own log shape: { "YYYY-MM-DD": ["stretch", "read"] }.
// Slugs are not validated against the slug pattern on purpose: an unknown one
// is reported back, not rejected.
export const importMiniSchema = z
  .object({
    log: z.record(isoDate, z.array(z.string().max(80)).max(200)),
  })
  .strict();
