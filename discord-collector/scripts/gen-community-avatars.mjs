import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "community-avatars");
const packs = [
  { id: "fun", names: ["cat", "dog", "fox", "panda", "owl", "frog", "bunny", "bear"] },
  { id: "emoji", names: ["grin", "cool", "wink", "heart", "star", "fire", "rocket", "moon"] },
];
const colors = {
  cat: ["#FFB347", "#FF8C42"],
  dog: ["#A0C4FF", "#4D96FF"],
  fox: ["#FF9F7A", "#E85D4C"],
  panda: ["#E8E8E8", "#333333"],
  owl: ["#C3B1E1", "#7B5EA7"],
  frog: ["#B5E48C", "#52B788"],
  bunny: ["#FFC6FF", "#FF85A1"],
  bear: ["#D4A373", "#8B5E3C"],
  grin: ["#FFE66D", "#F4A261"],
  cool: ["#90E0EF", "#0077B6"],
  wink: ["#FFAFCC", "#FB6F92"],
  heart: ["#FF6B6B", "#C9184A"],
  star: ["#FFD60A", "#F48C06"],
  fire: ["#FF6B35", "#D00000"],
  rocket: ["#80FFDB", "#5390D9"],
  moon: ["#B8C0FF", "#5A189A"],
};

function svg(name, c) {
  const [a, b] = c || ["#5865f2", "#3c45a5"];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${a}"/><stop offset="100%" stop-color="${b}"/></linearGradient></defs>
  <circle cx="64" cy="64" r="64" fill="url(#g)"/>
  <circle cx="64" cy="54" r="28" fill="rgba(255,255,255,0.92)"/>
  <ellipse cx="64" cy="100" rx="36" ry="22" fill="rgba(255,255,255,0.85)"/>
  <circle cx="54" cy="52" r="5" fill="#222"/><circle cx="74" cy="52" r="5" fill="#222"/>
  <path d="M52 66 Q64 76 76 66" fill="none" stroke="#222" stroke-width="3" stroke-linecap="round"/>
</svg>`;
}

for (const p of packs) {
  const dir = path.join(root, p.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of p.names) {
    fs.writeFileSync(path.join(dir, `${n}.svg`), svg(n, colors[n]));
  }
}
console.log("avatars written to", root);
