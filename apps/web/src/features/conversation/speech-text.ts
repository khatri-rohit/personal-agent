/**
 * Agent markdown → text worth hearing. Code, tables and diffs are useless read
 * symbol by symbol, so they become a one-line marker; markup is dropped and
 * links are read by their label.
 */
export function toSpeechText(markdown: string): string {
  let s = markdown.replace(/\r\n?/g, '\n');

  // Fenced code blocks (``` or ~~~), including an unterminated trailing one.
  s = s.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, '\nCode block skipped.\n');

  // Tables: a run of lines that start with "|".
  s = s.replace(/(?:^[ \t]*\|.*(?:\n|$))+/gm, '\nTable skipped.\n');

  s = s
    .replace(/<[^>]+>/g, ' ') // HTML tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
    .replace(/https?:\/\/\S+/g, 'link') // bare URLs
    .replace(/`([^`]+)`/g, '$1') // inline code → its text
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gm, '$1.') // headings end a sentence
    .replace(/^[ \t]*>[ \t]?/gm, '') // blockquotes
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '') // list markers
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, ' ') // rules
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2') // italics
    .replace(/~~(.*?)~~/g, '$1'); // strikethrough

  return s
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;]$/.test(line) ? line : `${line}.`))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/(Code block skipped\.|Table skipped\.)(?: \1)+/g, '$1')
    .trim();
}

/** Short enough that the first audio starts fast, long enough to sound natural. */
const TARGET_CHUNK_CHARS = 280;
/** The first chunk is smaller still: it is the only one the reader waits for. */
const FIRST_CHUNK_CHARS = 140;
/** Hard cap for one sentence with no punctuation (stays under the API limit). */
const MAX_CHUNK_CHARS = 600;

/** Sentence-grouped chunks: the player synthesises one while the last plays. */
export function chunkSpeech(text: string): string[] {
  // Split only where punctuation is followed by space, so "voice.routes.ts"
  // and "3.5" stay whole.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = '';

  const push = (piece: string) => {
    const t = piece.trim();
    if (t) chunks.push(t);
  };

  for (const raw of sentences) {
    let sentence = raw.trim();
    if (!sentence) continue;
    while (sentence.length > MAX_CHUNK_CHARS) {
      const cut = sentence.lastIndexOf(' ', MAX_CHUNK_CHARS);
      const at = cut > 0 ? cut : MAX_CHUNK_CHARS;
      push(current);
      current = '';
      push(sentence.slice(0, at));
      sentence = sentence.slice(at).trim();
    }
    const target = chunks.length === 0 ? FIRST_CHUNK_CHARS : TARGET_CHUNK_CHARS;
    if (current && current.length + sentence.length + 1 > target) {
      push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  push(current);
  return chunks;
}
