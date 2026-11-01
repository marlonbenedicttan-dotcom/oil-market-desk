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
  const t0 = Date.now();
  try {
    const r = await fetch(TARGET, { cf: { cacheTtl: 0, cacheEverything: false } });
    const line = `${TARGET} -> ${r.status} in ${Date.now() - t0}ms`;
    console.log(line);          // visible in `wrangler tail` and the dashboard logs
    return line;
  } catch (e) {
    const line = `${TARGET} -> ${e.message}`;
    console.error(line);
    return line;
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
