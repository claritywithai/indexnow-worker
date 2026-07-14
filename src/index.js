// ============================================================
// IndexNow Worker for claritywithai.org
// Handles: (1) serving the IndexNow key file as plain text
//          (2) daily cron job that checks sitemap.xml and submits
//              new URLs to IndexNow
// ============================================================

const INDEXNOW_KEY = "3d29f2e57c0af6bfc57701004ab526d6"; // change if you rotate the key
const HOST = "www.claritywithai.org";
const SITEMAP_URL = "https://www.claritywithai.org/sitemap.xml";
const KEY_LOCATION = `https://${HOST}/${INDEXNOW_KEY}.txt`;
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const SEEN_URLS_KV_KEY = "seen-urls";

export default {
  // Handles normal HTTP requests (serving the key file)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === `/${INDEXNOW_KEY}.txt`) {
      return new Response(INDEXNOW_KEY, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // Optional: manually trigger a submission by visiting /run-indexnow
    if (url.pathname === "/run-indexnow") {
      const result = await runIndexNowJob(env);
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  // Handles the scheduled cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIndexNowJob(env));
  },
};

async function runIndexNowJob(env) {
  const log = [];

  let allUrls;
  try {
    allUrls = await fetchSitemapUrls(SITEMAP_URL);
  } catch (e) {
    return { error: `Failed to fetch sitemap: ${e.message}` };
  }
  log.push(`Fetched ${allUrls.length} URL(s) from sitemap.`);

  const seenUrls = await getSeenUrls(env);
  const newUrls = allUrls.filter((u) => !seenUrls.has(u));

  if (newUrls.length === 0) {
    log.push("No new URLs found. Nothing to submit.");
    return { log };
  }

  log.push(`Found ${newUrls.length} new URL(s):`);
  newUrls.forEach((u) => log.push(`  + ${u}`));

  const submitResult = await submitToIndexNow(newUrls);
  log.push(`IndexNow response: ${submitResult.status}`);
  log.push(submitResult.body);

  if (submitResult.status === 200 || submitResult.status === 202) {
    newUrls.forEach((u) => seenUrls.add(u));
    await env.INDEXNOW_KV.put(SEEN_URLS_KV_KEY, JSON.stringify([...seenUrls]));
    log.push("Successfully submitted and updated seen-urls record.");
  } else {
    log.push("Submission failed — seen-urls record not updated, will retry next run.");
  }

  return { log };
}

async function fetchSitemapUrls(sitemapUrl) {
  const resp = await fetch(sitemapUrl, { cf: { cacheTtl: 0 } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const xml = await resp.text();

  // Check if this is a sitemap index (contains <sitemap> entries) or a urlset
  const subSitemapMatches = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>(.*?)<\/loc>[\s\S]*?<\/sitemap>/g)];
  if (subSitemapMatches.length > 0) {
    let urls = [];
    for (const match of subSitemapMatches) {
      const subUrls = await fetchSitemapUrls(match[1].trim());
      urls = urls.concat(subUrls);
    }
    return urls;
  }

  const urlMatches = [...xml.matchAll(/<url>[\s\S]*?<loc>(.*?)<\/loc>[\s\S]*?<\/url>/g)];
  return urlMatches.map((m) => m[1].trim());
}

async function getSeenUrls(env) {
  const raw = await env.INDEXNOW_KV.get(SEEN_URLS_KV_KEY);
  if (!raw) return new Set();
  try {
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function submitToIndexNow(urls) {
  const payload = {
    host: HOST,
    key: INDEXNOW_KEY,
    keyLocation: KEY_LOCATION,
    urlList: urls,
  };

  const resp = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });

  const body = await resp.text();
  return { status: resp.status, body };
}
