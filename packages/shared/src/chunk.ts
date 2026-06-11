const MAX_CHUNK_LENGTH = 1500;

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
    for (const paragraph of trimmed.split(/\n{2,}/)) {
      if (current && current.length + paragraph.length + 2 > maxLen) {
        chunks.push(current.trim());
        current = "";
      }
      // A single paragraph longer than maxLen is kept whole; the embedding
      // model truncates at its token limit anyway.
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    if (current.trim()) chunks.push(current.trim());
  }

  return chunks;
}
