const MAX_CHUNK_LENGTH = 1500;

export interface Chunk {
  content: string;
  /** Retracted by a later correction section of the same note. */
  superseded: boolean;
}

// A section whose heading declares a correction/retraction supersedes
// everything above it in the same note. Crude by design: the vault keeps the
// history of a wrong claim, so retrieval must know which part is current.
const CORRECTION_HEADING =
  /^#{1,6}\s.*\b(correction|corrected|correcting|retraction|retracted|retracts|superseded|supersedes|invalidated|wrong)\b/im;

function isCorrectionSection(section: string): boolean {
  const firstLine = section.slice(0, section.indexOf("\n") + 1 || section.length);
  return CORRECTION_HEADING.test(firstLine);
}

/** Hard-split a break-less run so no piece exceeds maxLen, preferring to cut on
 *  whitespace near the boundary. */
function splitOversized(text: string, maxLen: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(" ", maxLen);
    if (cut < maxLen * 0.6) cut = maxLen; // no useful space break — cut hard
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) pieces.push(rest.trim());
  return pieces;
}

export function chunkContent(body: string, maxLen = MAX_CHUNK_LENGTH): Chunk[] {
  const sections = body.split(/\n(?=#{1,6}\s)/);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // A correction section retracts every chunk emitted before it; its own
    // chunks are current (until an even later correction retracts them too).
    if (isCorrectionSection(trimmed)) {
      for (const chunk of chunks) chunk.superseded = true;
    }

    if (trimmed.length <= maxLen) {
      chunks.push({ content: trimmed, superseded: false });
      continue;
    }
    let current = "";
    const flush = () => {
      if (current.trim()) chunks.push({ content: current.trim(), superseded: false });
      current = "";
    };
    for (const paragraph of trimmed.split(/\n{2,}/)) {
      // A single paragraph longer than maxLen must be hard-split: Qwen3 has a
      // 32K context so it would NOT truncate it, and an oversized chunk is both
      // poor retrieval and a heavy embed that can wedge a constrained host.
      if (paragraph.length > maxLen) {
        flush();
        for (const piece of splitOversized(paragraph, maxLen)) {
          chunks.push({ content: piece, superseded: false });
        }
        continue;
      }
      if (current && current.length + paragraph.length + 2 > maxLen) flush();
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    flush();
  }

  return chunks;
}
