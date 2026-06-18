const fs = require("fs");
const path = require("path");

const EVENTS_TABLE = "google_play_events";
const BEIJING_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function isAuthorized(req) {
  const secret = process.env.COLLECT_SECRET || process.env.CRON_SECRET;
  if (!secret) {
    return true;
  }

  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const querySecret = req.query?.secret;
  const headerSecret = req.headers["x-collect-secret"];

  return bearerToken === secret || querySecret === secret || headerSecret === secret;
}

function getConfig() {
  const configPath = path.join(process.cwd(), "owned-products.config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function getBeijingDateText(date) {
  const beijingDate = new Date(date.getTime() + BEIJING_TIME_OFFSET_MS);
  const year = beijingDate.getUTCFullYear();
  const month = String(beijingDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(beijingDate.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function decodeHtml(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function getEstimatedEndDate(relativeEndTime, collectedAt) {
  const match = relativeEndTime.match(/Ends in (\d+) (day|days|hour|hours)/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const endDate = new Date(collectedAt);

  if (unit.startsWith("day")) {
    endDate.setUTCDate(endDate.getUTCDate() + amount);
  } else {
    endDate.setUTCHours(endDate.getUTCHours() + amount);
  }

  return getBeijingDateText(endDate);
}

function getGooglePlayEventUrl(eventHref) {
  if (!eventHref) {
    return "";
  }

  const url = new URL(eventHref, "https://play.google.com");
  url.searchParams.set("gl", "US");
  url.searchParams.set("hl", "en");
  return url.toString();
}

function parseEventCards(html, product, collectedAt) {
  const eventCards = html.match(/<a class="Si6A0c[^"]*" href="[^"]*\/store\/apps\/eventdetails\/[^"]*">[\s\S]*?<\/a>/g) || [];

  return eventCards.map((card) => {
    const relativeEndTime = decodeHtml(card.match(/<div class="DU6Edd [^"]+">([^<]+)<\/div>/)?.[1] || "");
    const imageUrl = decodeHtml(card.match(/<img src="([^"]+)"/)?.[1] || "");
    const title = decodeHtml(card.match(/<div class="gFWm9b [^"]+">([^<]+)<\/div>/)?.[1] || "");
    const eventHref = decodeHtml(card.match(/href="([^"]*\/store\/apps\/eventdetails\/[^"]+)"/)?.[1] || "");

    if (!title || !relativeEndTime || !relativeEndTime.startsWith("Ends in")) {
      return null;
    }

    return {
      app_id: product.google_play_package,
      product_key: product.key,
      app_name: product.name,
      event_title: title,
      relative_end_time: relativeEndTime,
      estimated_end_date: getEstimatedEndDate(relativeEndTime, collectedAt),
      image_url: imageUrl,
      event_url: getGooglePlayEventUrl(eventHref),
      collected_at: collectedAt.toISOString(),
      beijing_date: getBeijingDateText(collectedAt)
    };
  }).filter(Boolean);
}

async function fetchProductEvents(product, collectedAt) {
  const url = `https://play.google.com/store/apps/details?id=${product.google_play_package}&gl=US&hl=en`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 StoreInsightBot"
    }
  });

  if (!response.ok) {
    throw new Error(`Google Play page failed for ${product.key}: HTTP ${response.status}`);
  }

  const html = await response.text();
  return parseEventCards(html, product, collectedAt);
}

async function supabaseRequest(pathname, options = {}) {
  const supabaseUrl = getRequiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const serviceKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  const response = await fetch(`${supabaseUrl}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase request failed: HTTP ${response.status} ${errorText}`);
  }

  return response;
}

async function replaceDailyEvents(beijingDate, rows) {
  await supabaseRequest(`${EVENTS_TABLE}?beijing_date=eq.${beijingDate}`, {
    method: "DELETE"
  });

  if (rows.length === 0) {
    return;
  }

  await supabaseRequest(EVENTS_TABLE, {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(rows)
  });
}

module.exports = async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const collectedAt = new Date();
  const beijingDate = getBeijingDateText(collectedAt);

  try {
    const config = getConfig();
    const products = (config.products || [])
      .filter((product) => product.enabled !== false && product.google_play_package);

    const results = await Promise.allSettled(products.map((product) => fetchProductEvents(product, collectedAt)));
    const rows = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const product_event_counts = results.map((result, index) => ({
      product_key: products[index].key,
      app_name: products[index].name,
      events: result.status === "fulfilled" ? result.value.length : 0,
      error: result.status === "rejected" ? result.reason.message : ""
    }));

    await replaceDailyEvents(beijingDate, rows);

    return res.status(200).json({
      ok: true,
      beijing_date: beijingDate,
      products: products.length,
      events: rows.length,
      product_event_counts,
      failed_products: results.filter((result) => result.status === "rejected").length
    });
  } catch (error) {
    console.error("Google Play events collector failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
