import fs from "node:fs/promises";
import path from "node:path";

/** @param {string} archivesDir @param {string} videoId */
export async function archiveExists(archivesDir, videoId) {
  if (!/^[\w-]{11}$/.test(videoId)) return false;
  try {
    await fs.access(path.join(archivesDir, `${videoId}.md`));
    await fs.access(path.join(archivesDir, `${videoId}.json`));
    return true;
  } catch {
    return false;
  }
}
