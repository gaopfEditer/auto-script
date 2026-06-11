/**
 * 解析 youtube-transcript.ai 返回的 Markdown 文稿。
 * @param {string} raw
 * @param {string} videoId
 */
export function parseTranscriptMarkdown(raw, videoId) {
  const text = String(raw ?? "");
  const titleMatch = text.match(/^#\s*Transcript:\s*(.+)$/m);
  const sourceMatch = text.match(/^Source video:\s*(.+)$/m);
  const langMatch = text.match(/^Language:\s*(.+)$/m);
  const idx = text.indexOf("\n## Transcript\n");
  const transcript =
    idx >= 0 ? text.slice(idx + "\n## Transcript\n".length).trim() : text.trim();

  return {
    videoId,
    title: titleMatch?.[1]?.trim() ?? null,
    sourceUrl: sourceMatch?.[1]?.trim() ?? `https://www.youtube.com/watch?v=${videoId}`,
    languageLine: langMatch?.[1]?.trim() ?? null,
    transcript,
    raw,
  };
}
