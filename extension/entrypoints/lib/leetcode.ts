export const LEETCODE_SITES = ['leetcode.cn', 'leetcode.com'] as const;
export type LeetCodeSite = (typeof LEETCODE_SITES)[number];

export function leetcodeSiteOf(url: string | undefined): LeetCodeSite | null {
  if (!url) return null;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (LEETCODE_SITES as readonly string[]).includes(hostname)
      ? (hostname as LeetCodeSite)
      : null;
  } catch {
    return null;
  }
}
