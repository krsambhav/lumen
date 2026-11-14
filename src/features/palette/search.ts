/**
 * Matching what is typed into the palette against names (DESIGN.md §7,
 * "Command palette").
 *
 * Every word typed must be found. A word scores most at the start of the
 * name, then at the start of one of its words, then as the beginnings of
 * several of its words in order ("sp" for "show playlist", "gtt" for "go to
 * time"), and least anywhere inside a word, where it must appear as typed.
 * There is no looser matching than that: letters scattered through a name
 * ("mute" in "minute") find things nobody meant. Figures are always taken
 * as typed, or "1.5" would find 1.25 and 1.75. The total decides the order.
 */

const LETTERS_ONLY = /^\p{L}+$/u;

const SEPARATOR = /[\s._\-–—()[\]/“”"'’:,]+/u;

/** Where each word of `text` starts. */
function wordStarts(text: string): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const word of text.split(SEPARATOR)) {
    const found = text.indexOf(word, at);
    if (word !== "" && found >= 0) {
      starts.push(found);
      at = found + word.length;
    }
  }
  return starts;
}

/** The words of `text`, in order. */
function wordsOf(text: string): string[] {
  return text.split(SEPARATOR).filter(Boolean);
}

/**
 * True if `typed` is the beginnings of two or more of `words`, in order:
 * all of it used up, each piece the start of a later word than the last.
 */
function isBeginnings(typed: string, words: readonly string[]): boolean {
  const from = (at: number, word: number, used: number): boolean => {
    if (at === typed.length) {
      return used >= 2;
    }
    for (let next = word; next < words.length; next += 1) {
      const candidate = words[next] ?? "";
      for (let length = 1; length <= candidate.length; length += 1) {
        if (!typed.startsWith(candidate.slice(0, length), at)) {
          break;
        }
        if (from(at + length, next + 1, used + 1)) {
          return true;
        }
      }
    }
    return false;
  };
  return from(0, 0, 0);
}

const AT_THE_START = 100;
const AT_A_WORD = 80;
const BEGINNINGS = 60;
const INSIDE = 40;

function scoreWord(word: string, text: string, starts: readonly number[]): number {
  if (text.startsWith(word)) {
    return AT_THE_START;
  }
  if (starts.some((start) => text.startsWith(word, start))) {
    return AT_A_WORD;
  }
  if (word.length >= 2 && LETTERS_ONLY.test(word) && isBeginnings(word, wordsOf(text))) {
    return BEGINNINGS;
  }
  return text.includes(word) ? INSIDE : 0;
}

/** How well another word for the thing answers: less than its own name would. */
const AS_A_KEYWORD = 0.55;

/**
 * How well `text` answers `query`: 0 if it does not, more for a better
 * answer. `keywords` are other things it is called; a word typed may be
 * found in one of those instead, for less.
 */
export function score(query: string, text: string, keywords: readonly string[] = []): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return 0;
  }
  const lowered = text.toLowerCase();
  const starts = wordStarts(lowered);
  const others = keywords.map((keyword) => {
    const lower = keyword.toLowerCase();
    return { text: lower, starts: wordStarts(lower) };
  });
  let total = 0;
  for (const word of words) {
    let found = scoreWord(word, lowered, starts);
    for (const other of others) {
      // In a keyword only the start of a word counts: they are short, and
      // a word found inside one would be a guess.
      const within = scoreWord(word, other.text, other.starts);
      if (within >= AT_A_WORD) {
        found = Math.max(found, within * AS_A_KEYWORD);
      }
    }
    if (found === 0) {
      return 0;
    }
    total += found;
  }
  // Of two equal answers the shorter name is the closer one.
  return total - Math.min(9, lowered.length / 20);
}

/** The best `limit` of `items` for `query`, best first. Ties keep their order. */
export function best<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
  limit: number,
): T[] {
  return ranked(query, items, text)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** Every one of `items` that answers `query`, with its score, best first. Ties keep their order. */
export function ranked<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
  keywords: (item: T) => readonly string[] = () => [],
): { item: T; score: number }[] {
  return items
    .map((item, index) => ({ item, index, score: score(query, text(item), keywords(item)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item, score: found }) => ({ item, score: found }));
}
