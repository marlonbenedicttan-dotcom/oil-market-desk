// Keep the watchtower awake from Cloudflare's scheduler.
//
// Render's free plan sleeps a web service after ~15 minutes without traffic, and waking it takes 20-30
// seconds. Any request resets the timer, so a five-minute ping keeps it warm. GitHub Actions proved
// unreliable at this frequency (it fired once and then stalled); Workers cron triggers are not.
//
// Deploy (one command, after `npx wrangler login`):
//   cd workers/keepalive && npx wrangler deploy
//
// Test by hand:
//   curl https://watchtower-keepalive.<your-subdomain>.workers.dev
const TARGET = 'https://oil-market-desk.onrender.com/health';

async function ping() {
  try {
    const r = await fetch(TARGET, { cf: { cacheTtl: 0, cacheEverything: false } });
    return `${TARGET} -> ${r.status}`;
  } catch (e) {
    return `${TARGET} -> ${e.message}`;
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ping());
  },
  async fetch() {
    return new Response(await ping(), { headers: { 'content-type': 'text/plain' } });
  },
};
