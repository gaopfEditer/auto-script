/** @param {string} md */
export function parseArchiveMd(md) {
  const text = String(md ?? "");
  const lines = text.split(/\r?\n/);

  let title = null;
  if (lines[0]?.startsWith("# ")) title = lines[0].slice(2).trim();

  let sourceUrl = null;
  let languageLine = null;
  let fetchedAt = null;
  for (const line of lines.slice(1, 12)) {
    if (line.startsWith("Source:")) sourceUrl = line.slice("Source:".length).trim();
    if (line.startsWith("Language:")) languageLine = line.slice("Language:".length).trim();
    if (line.startsWith("Fetched:")) fetchedAt = line.slice("Fetched:".length).trim();
  }

  const idx = text.indexOf("\n## Transcript\n");
  const transcript = idx >= 0 ? text.slice(idx + "\n## Transcript\n".length).trim() : "";

  return { title, sourceUrl, languageLine, fetchedAt, transcript };
}
