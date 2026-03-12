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
 * Detect the dominant language/script of a text string.
 * Strips common technical noise (URLs, code blocks, kubectl output) before analysis.
 */
export function detectLanguage(text: string): string {
  // Strip noise that shouldn't influence detection:
  // URLs, inline code, code blocks, kubectl-style paths (pod/xxx, ns/xxx)
  const cleaned = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\b[\w-]+\/[\w.-]+/g, "") // resource paths
    .replace(/--[\w-]+(=\S+)?/g, "")   // CLI flags
    .trim();

  if (!cleaned) return "English";

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
  if (total === 0) return "English";

  // Require at least 2 script characters to avoid false positives from
  // stray technical terms embedded in English sentences. Single characters
  // are too noisy for an SRE tool where mixed-language input is common.
  const MIN_CHARS = 2;

  // Japanese: presence of kana is definitive (Chinese doesn't use kana)
  if (ja >= MIN_CHARS) return "Japanese";
  if (ko >= MIN_CHARS) return "Korean";
  // CJK alone needs slightly higher bar — could be a single term embedded in English
  if (cjk >= MIN_CHARS) return "Chinese";
  if (cyrillic >= MIN_CHARS) return "Russian";
  if (arabic >= MIN_CHARS) return "Arabic";
  if (thai >= MIN_CHARS) return "Thai";
  if (devanagari >= MIN_CHARS) return "Hindi";

  // Below threshold — treat as English with incidental non-Latin characters
  return "English";
}
