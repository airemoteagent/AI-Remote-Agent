// headlines — top news headlines (no API key, no deps).
export default {
  name: 'headlines',
  description: 'Fetch the top 5 news headlines (Hacker News front page).',
  args: { limit: 'number — optional, max headlines (default 5, max 10)' },
  platform: 'any',
  async run(args) {
    const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
    try {
      const res = await fetch('https://hnrss.org/frontpage', {
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const html = await res.text();
      const titles = [...html.matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1].trim());
      // first <title> is the feed title itself
      const items = titles.slice(1, limit + 1);
      return { headlines: items };
    } catch (err) {
      return { error: `Headlines unavailable: ${err.message}` };
    }
  },
};
