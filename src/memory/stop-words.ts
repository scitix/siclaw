/** Common English stop words to filter from FTS queries */
const ENGLISH_STOP_WORDS = new Set([
  // Articles and determiners
  "a", "an", "the", "this", "that", "these", "those",
  // Pronouns
  "i", "me", "my", "we", "our", "you", "your",
  "he", "she", "it", "they", "them",
  // Common verbs / auxiliaries
  "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "can", "may", "might",
  // Prepositions
  "in", "on", "at", "to", "for", "of", "with", "by",
  "from", "about", "into", "through", "during",
  "before", "after", "above", "below", "between", "under", "over",
  // Conjunctions
  "and", "or", "but", "if", "then", "because", "as", "while",
  "when", "where", "what", "which", "who", "how", "why",
  // Time references (vague, not useful for FTS)
  "yesterday", "today", "tomorrow", "earlier", "later",
  "recently", "ago", "just", "now",
  // Vague references
  "thing", "things", "stuff", "something", "anything",
  "everything", "nothing",
  // Question/request words
  "please", "help", "find", "show", "get", "tell", "give",
  // Other function words
  "no", "not", "such",
]);

/** Common Chinese stop words (function words / particles) */
const CHINESE_STOP_WORDS = new Set([
  // Pronouns
  "我", "我们", "你", "你们", "他", "她", "它", "他们",
  "这", "那", "这个", "那个", "这些", "那些",
  // Auxiliary words / particles
  "的", "了", "着", "过", "得", "地",
  "吗", "呢", "吧", "啊", "呀", "嘛", "啦",
  // Common verbs (vague)
  "是", "有", "在", "被", "把", "给", "让", "用",
  "到", "去", "来", "做", "说", "看", "找",
  "想", "要", "能", "会", "可以",
  // Prepositions and conjunctions
  "和", "与", "或", "但", "但是", "因为", "所以",
  "如果", "虽然", "而",
  // Adverbs
  "也", "都", "就", "还", "又", "再", "才", "只",
  "不", "没有",
  // Time (vague)
  "之前", "以前", "之后", "以后", "刚才", "现在",
  "昨天", "今天", "明天", "最近",
  // Vague references
  "东西", "事情", "事", "什么", "哪个", "哪些",
  "怎么", "为什么", "多少",
  // Question/request words
  "请", "帮", "帮忙", "告诉",
  // Other function words
  "人", "个", "上", "们", "一", "好", "自己", "从", "么",
]);

function isStopWord(t: string): boolean {
  return ENGLISH_STOP_WORDS.has(t.toLowerCase()) || CHINESE_STOP_WORDS.has(t);
}

/** Check if a token is a valid keyword (not pure digits, not too-short English, not punctuation-only) */
function isValidKeyword(t: string): boolean {
  if (!t || t.length === 0) return false;
  // Reject pure digits
  if (/^\d+$/.test(t)) return false;
  // Reject short ASCII-only words (< 3 chars) — e.g., "ab", "x"
  if (t.length < 3 && /^[a-z]+$/.test(t)) return false;
  // Reject tokens that are all underscores or punctuation/symbols
  if (/^[_\p{P}\p{S}]+$/u.test(t)) return false;
  return true;
}

/**
 * Tokenize a query string for FTS search.
 * - Lowercases all tokens for case-insensitive matching
 * - Preserves underscores in identifiers (e.g., memory_search)
 * - Generates CJK character bigrams for Chinese text matching
 * - Filters stop words, pure digits, and too-short English words
 */
export function tokenizeForFts(query: string): string[] {
  // Match unicode letters, numbers, and underscores as tokens
  const rawTokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const tokens: string[] = [];
  const seen = new Set<string>();

  const add = (t: string) => {
    const lower = t.toLowerCase();
    if (!lower || seen.has(lower) || isStopWord(lower) || !isValidKeyword(lower)) return;
    seen.add(lower);
    tokens.push(lower);
  };

  for (const token of rawTokens) {
    // Check for CJK characters
    if (/[\u4e00-\u9fff]/.test(token)) {
      // Extract CJK character sequences
      const cjkChars = [...token].filter((c) => /[\u4e00-\u9fff]/.test(c));
      // Prefer bigrams for FTS (unigrams are too broad, matching nearly everything)
      // Only add unigrams as fallback for single-character CJK input
      if (cjkChars.length === 1) {
        add(cjkChars[0]);
      }
      // Add bigrams for precise phrase matching
      for (let i = 0; i < cjkChars.length - 1; i++) {
        add(cjkChars[i] + cjkChars[i + 1]);
      }
      // Also extract any non-CJK parts (e.g., "API讨论" → "API" + CJK bigrams)
      const nonCjk = token.replace(/[\u4e00-\u9fff]+/g, " ").trim();
      if (nonCjk) {
        for (const part of nonCjk.split(/\s+/)) {
          if (part) add(part);
        }
      }
    } else {
      add(token);
    }
  }

  return tokens;
}

/**
 * Filter stop words from a list of tokens.
 * Removes common English and Chinese function words that add noise to FTS queries.
 */
export function filterStopWords(tokens: string[]): string[] {
  return tokens.filter((t) => !isStopWord(t));
}

/**
 * Extract meaningful keywords from a conversational query for FTS-only search.
 * Strips stop words, vague references, and short fragments, returning only
 * tokens likely to produce useful FTS matches.
 *
 * Examples:
 * - "that thing we discussed about the API" → ["discussed", "api"]
 * - "之前讨论的那个方案" → ["讨论", "方案"]  (via bigrams from tokenizeForFts)
 */
export function extractKeywords(query: string): string[] {
  return tokenizeForFts(query);
}
