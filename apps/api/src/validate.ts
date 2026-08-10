/**
 * Write-path validation for the vault. Persisted knowledge is English-only
 * and every note declares what it is (kind) so retrieval can weigh authority
 * and expiry. Rejections are 400s with instructions the writing agent can act
 * on directly.
 */

export class ValidationError extends Error {
  statusCode = 400;
}

export const NOTE_KINDS = [
  "measurement",
  "report",
  "task",
  "runbook",
  "decision",
  "doctrine",
  "idea",
  "index",
  "reference",
  "archive",
] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export function assertKind(kind: unknown): NoteKind {
  if (typeof kind === "string" && (NOTE_KINDS as readonly string[]).includes(kind)) {
    return kind as NoteKind;
  }
  throw new ValidationError(
    `Required field: kind — one of ${NOTE_KINDS.join(", ")}. ` +
      "What is this note? measurement/report for readings and session results, " +
      "task for work items (they expire when done), runbook for how-tos, " +
      "decision/doctrine for rules that outrank readings, idea for proposals, " +
      "index for navigation hubs, reference for pointers, archive for historical imports."
  );
}

const MAX_TITLE_LENGTH = 90;

export function assertTitle(title: string): void {
  if (title.trim().length === 0) throw new ValidationError("Title must not be empty");
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(
      `Title too long (${title.length} > ${MAX_TITLE_LENGTH} chars). ` +
        "A title is a name, not a summary — put the conclusion in the first line of content instead."
    );
  }
}

// Persisted artifacts are English-only (short quoted fragments are fine —
// the gate is a ratio with an absolute floor, not a blanket ban on Cyrillic).
const CYRILLIC_FLOOR = 40;
const CYRILLIC_RATIO = 0.15;

export function assertEnglish(text: string, label: string): void {
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  if (cyrillic <= CYRILLIC_FLOOR) return;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cyrillic / (cyrillic + latin) > CYRILLIC_RATIO) {
    throw new ValidationError(
      `${label} must be written in English — the vault is English-only so one search reaches ` +
        "everything (quoting a short original-language fragment is fine). Translate and retry."
    );
  }
}
