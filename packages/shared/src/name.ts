const LEET_MAP: Record<string, string> = {
  "4": "a", "@": "a", "8": "b", "3": "e", "6": "g",
  "1": "l", "!": "i", "0": "o", "5": "s", "$": "s", "7": "t", "9": "g",
};

/**
 * Keep the list small and neutral — the goal is to block obvious profanity on
 * a family-friendly casual game, not to build a filter that can never miss.
 */
const BANNED = [
  "anal", "anus", "arse", "asshole", "bastard", "bitch", "bollock", "boob",
  "clit", "cock", "cuck", "cunt", "dick", "dildo", "fag", "fuck", "hooker",
  "jizz", "nazi", "nigga", "nigger", "penis", "porn", "prick", "pussy",
  "rape", "retard", "scrotum", "semen", "shit", "slut", "tranny", "twat",
  "vagina", "wank", "whore",
];

export const NAME_MIN = 2;
export const NAME_MAX = 16;

export class BannedNameError extends Error {}

function normaliseForFilter(raw: string): string {
  let lower = raw.toLowerCase();
  try {
    lower = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch {
    /* engines without normalize */
  }
  let out = "";
  for (const ch of lower) out += LEET_MAP[ch] ?? ch;
  // collapse letter runs: "biiitch" -> "bitch"
  return out.replace(/(.)\1{2,}/g, "$1");
}

export class InvalidNameError extends Error {}

/**
 * Sanitise a display name (spec 6.4 and 13):
 *   trim, collapse whitespace, strip control characters,
 *   enforce length 2..16, and reject obvious profanity
 *   (leetspeak-aware).
 */
export function sanitiseName(raw: string | undefined): string {
  if (raw == null) throw new InvalidNameError("a name is required");
  let name = String(raw)
    .replace(/[\u0000-\u001f\u007f\u00a0\u200b-\u200f]/g, " ")
    .replace(/[<>\\"'`&{}[\]|~^\u00ad]/g, "")
    .replace(/[^\w,.\- \u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\u4e00-\u9fa5]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX);
  if (name.length < NAME_MIN) throw new InvalidNameError(`name must be at least ${NAME_MIN} characters`);

  const lower = normaliseForFilter(name);
  for (const word of BANNED) {
    const re = new RegExp(`(^|[^a-z])${word}([^a-z]|$)`);
    if (re.test(lower)) throw new BannedNameError("pick a family-friendly name");
  }
  return name;
}

export function nameIsProfane(text: string): boolean {
  const lower = normaliseForFilter(text);
  return BANNED.some(
    (word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(lower),
  );
}
