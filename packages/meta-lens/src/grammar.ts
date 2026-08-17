/**
 * The glass grammar, enforced at the last mile — identical rules to the G2
 * lens: uppercase, no punctuation but the interpunct, money rounded to whole
 * units, lines under 60 characters. The AI service is the source of truth
 * (packages/ai-service/app/cue.py); this module only guards what it renders.
 */

export const MAX_CHARS = 60;
export const CUE_LINES = 3;
export const INTERPUNCT = " · ";

export function toDisplayText(line: string): string {
  return line
    .replace(/\[ICON:\w+\]\s?/g, "")
    .toUpperCase()
    .replace(/[.,!?;:"]/g, "")
    .trim()
    .slice(0, MAX_CHARS);
}

export function money(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "";
  return `$${Math.round(n)}`;
}

export function joinMeta(facts: (string | undefined)[]): string {
  return facts.filter((f): f is string => !!f && f.length > 0).join(INTERPUNCT);
}
