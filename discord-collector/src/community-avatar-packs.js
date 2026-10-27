/**
 * 社区内置头像包（静态文件在 public/community-avatars/）。
 */

/** @typedef {{ id: string, label: string, avatars: { id: string, label: string, url: string }[] }} AvatarPack */

/** @type {AvatarPack[]} */
export const COMMUNITY_AVATAR_PACKS = [
  {
    id: "fun",
    label: "萌宠派对",
    avatars: [
      { id: "cat", label: "小猫", url: "/community-avatars/fun/cat.svg" },
      { id: "dog", label: "小狗", url: "/community-avatars/fun/dog.svg" },
      { id: "fox", label: "狐狸", url: "/community-avatars/fun/fox.svg" },
      { id: "panda", label: "熊猫", url: "/community-avatars/fun/panda.svg" },
      { id: "owl", label: "猫头鹰", url: "/community-avatars/fun/owl.svg" },
      { id: "frog", label: "青蛙", url: "/community-avatars/fun/frog.svg" },
      { id: "bunny", label: "兔子", url: "/community-avatars/fun/bunny.svg" },
      { id: "bear", label: "小熊", url: "/community-avatars/fun/bear.svg" },
    ],
  },
  {
    id: "emoji",
    label: "表情能量",
    avatars: [
      { id: "grin", label: "大笑", url: "/community-avatars/emoji/grin.svg" },
      { id: "cool", label: "酷", url: "/community-avatars/emoji/cool.svg" },
      { id: "wink", label: "眨眼", url: "/community-avatars/emoji/wink.svg" },
      { id: "heart", label: "爱心", url: "/community-avatars/emoji/heart.svg" },
      { id: "star", label: "星星", url: "/community-avatars/emoji/star.svg" },
      { id: "fire", label: "火焰", url: "/community-avatars/emoji/fire.svg" },
      { id: "rocket", label: "火箭", url: "/community-avatars/emoji/rocket.svg" },
      { id: "moon", label: "月亮", url: "/community-avatars/emoji/moon.svg" },
    ],
  },
];

/** @returns {Set<string>} */
export function allowedAvatarUrls() {
  const set = new Set();
  for (const pack of COMMUNITY_AVATAR_PACKS) {
    for (const a of pack.avatars) set.add(a.url);
  }
  return set;
}
