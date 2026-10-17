/**
 * The eight preset emotes (spec 6.4). Ids are stable strings; icons are
 * rendered client-side from these ids (no user content, no moderation risk).
 */
export const EMOTES = [
  { id: "wave",    glyph: "👋", label: "Wave" },
  { id: "thumbs",  glyph: "👍", label: "Thumbs up" },
  { id: "laugh",   glyph: "😄", label: "Laugh" },
  { id: "angry",   glyph: "😠", label: "Angry" },
  { id: "heart",   glyph: "❤️", label: "Love" },
  { id: "dance",   glyph: "🕺", label: "Dance" },
  { id: "salute",  glyph: "🫡", label: "Salute" },
  { id: "turbo",   glyph: "🚀", label: "Turbo" },
] as const;

export type EmoteId = (typeof EMOTES)[number]["id"];
export const EMOTE_IDS: readonly string[] = EMOTES.map((e) => e.id);
export const EMOTE_DURATION_MS = 3000;

export function isValidEmoteId(id: unknown): id is EmoteId {
  return typeof id === "string" && (EMOTE_IDS as readonly string[]).includes(id);
}
