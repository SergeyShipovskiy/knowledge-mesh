const MAX_CHUNK_LENGTH = 1500;

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

export function chunkContent(body: string, maxLen = MAX_CHUNK_LENGTH): string[] {
  const sections = body.split(/\n(?=#{1,6}\s)/);
  const chunks: string[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxLen) {
      chunks.push(trimmed);
      continue;
    }
    let current = "";
    const flush = () => {
      if (current.trim()) chunks.push(current.trim());
      current = "";
    };
    for (const paragraph of trimmed.split(/\n{2,}/)) {
      // A single paragraph longer than maxLen must be hard-split: Qwen3 has a
      // 32K context so it would NOT truncate it, and an oversized chunk is both
      // poor retrieval and a heavy embed that can wedge a constrained host.
      if (paragraph.length > maxLen) {
        flush();
        for (const piece of splitOversized(paragraph, maxLen)) chunks.push(piece);
        continue;
      }
      if (current && current.length + paragraph.length + 2 > maxLen) flush();
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    flush();
  }

  return chunks;
}
