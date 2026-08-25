/**
 * D1 caps bound parameters at 100 per query, regardless of plan (CLAUDE.md section 3).
 * Chunk rows into groups that fit under that cap given how many params one row's INSERT
 * needs, so a migration that adds/removes a column can't silently produce a chunk that
 * blows the cap — the row-per-chunk count is derived, never hardcoded.
 */
export function chunkByParamCount<T>(
  rows: readonly T[],
  paramsPerRow: number,
  maxParams = 100,
): T[][] {
  if (paramsPerRow <= 0) throw new Error("paramsPerRow must be positive");
  const rowsPerChunk = Math.max(1, Math.floor(maxParams / paramsPerRow));

  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    chunks.push(rows.slice(i, i + rowsPerChunk));
  }
  return chunks;
}
