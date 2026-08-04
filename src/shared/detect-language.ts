/**
 * Deterministic language detection based on Unicode script analysis.
 *
 * Returns an ISO-ish language label (e.g. "English", "Japanese", "Chinese", "Korean").
 * This is intentionally simple — it detects the *dominant script*, not NLP-level language ID.
 * Good enough to drive "respond in X" instructions without relying on model behavior.
 */

// Unicode ranges for script detection
const HIRAGANA = /[\u3040-\u309F]/;
const KATAKANA = /[\u30A0-\u30FF]/;
const CJK = /[\u4E00-\u9FFF\u3400-\u4DBF]/;
const HANGUL = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;
const CYRILLIC = /[\u0400-\u04FF]/;
const ARABIC = /[\u0600-\u06FF\u0750-\u077F]/;
const THAI = /[\u0E00-\u0E7F]/;
const DEVANAGARI = /[\u0900-\u097F]/;

/**
 * Minimum script characters before a script is claimed. Guards against a lone
 * technical term in otherwise foreign text — mixed-language input is normal in
 * an SRE tool.
 */
const MIN_CHARS = 2;

const LATIN_LETTER_COUNT = (text: string): number => (text.match(/[A-Za-z]/g) ?? []).length;

/**
 * Detect the dominant language/script of a text string, or `null` when the text
 * carries no evidence either way.
 *
 * The distinction matters because a caller can now have a configured fallback.
 * Collapsing "this is English" and "I cannot tell" into one answer is what made
 * a Chinese conversation flip to English the moment someone replied `1` — the
 * digits are not evidence of anything, but they counted as English.
 *
 * Latin script still resolves to English rather than to null. It is weak
 * evidence — Latin is shared by dozens of languages — but it is the ONLY
 * evidence available, and treating it as absent would mean an English question
 * to a Chinese-configured agent came back in Chinese. That inverts the rule the
 * caller is applying, where what the user actually wrote wins.
 */
export function detectScriptLanguage(text: string): string | null {
  // Strip noise that shouldn't influence detection:
  // URLs, inline code, code blocks, kubectl-style paths (pod/xxx, ns/xxx)
  const cleaned = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\b[\w-]+\/[\w.-]+/g, "") // resource paths
    .replace(/--[\w-]+(=\S+)?/g, "")   // CLI flags
    .trim();

  // Nothing left after stripping noise — an attachment-only turn, or pure
  // punctuation. No evidence either way.
  if (!cleaned) return null;

  // Count script characters (ignoring ASCII, punctuation, digits, whitespace)
  let ja = 0, cjk = 0, ko = 0, cyrillic = 0, arabic = 0, thai = 0, devanagari = 0;

  for (const ch of cleaned) {
    if (HIRAGANA.test(ch) || KATAKANA.test(ch)) ja++;
    else if (HANGUL.test(ch)) ko++;
    else if (CJK.test(ch)) cjk++;
    else if (CYRILLIC.test(ch)) cyrillic++;
    else if (ARABIC.test(ch)) arabic++;
    else if (THAI.test(ch)) thai++;
    else if (DEVANAGARI.test(ch)) devanagari++;
  }

  // Total non-ASCII script characters
  const total = ja + cjk + ko + cyrillic + arabic + thai + devanagari;
  if (total === 0) {
    // Latin script is evidence of English; digits, punctuation and symbols are
    // evidence of nothing. Same MIN_CHARS bar the other scripts are held to —
    // exempting Latin is exactly what made `1` mean "English".
    return LATIN_LETTER_COUNT(cleaned) >= MIN_CHARS ? "English" : null;
  }


  // Japanese: presence of kana is definitive (Chinese doesn't use kana)
  if (ja >= MIN_CHARS) return "Japanese";
  if (ko >= MIN_CHARS) return "Korean";
  // CJK alone needs slightly higher bar — could be a single term embedded in English
  if (cjk >= MIN_CHARS) return "Chinese";
  if (cyrillic >= MIN_CHARS) return "Russian";
  if (arabic >= MIN_CHARS) return "Arabic";
  if (thai >= MIN_CHARS) return "Thai";
  if (devanagari >= MIN_CHARS) return "Hindi";

  // Below threshold: a stray non-Latin character in otherwise Latin text. Fall
  // back to the same Latin test rather than asserting English outright.
  return LATIN_LETTER_COUNT(cleaned) >= MIN_CHARS ? "English" : null;
}
