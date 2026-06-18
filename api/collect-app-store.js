const fs = require("fs");
const path = require("path");

const CHARTS = [
  {
    chart_type: "us_games",
    url: "https://itunes.apple.com/us/rss/topfreeapplications/limit=100/genre=6014/json"
  },
  {
    chart_type: "us_apps",
    url: "https://itunes.apple.com/us/rss/topfreeapplications/limit=100/json"
  }
];
const BEIJING_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;
const SCHEDULED_BEIJING_HOURS = new Set([0, 5, 9, 13, 17, 21]);
const COLLECTION_MINUTE = 10;
const COLLECTION_WINDOW_MINUTES = 30;
const SNAPSHOT_TABLE = "app_store_rank_snapshots";
const PROFILE_TABLE = "owned_product_profiles";

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function getBeijingParts(date) {
  const beijingDate = new Date(date.getTime() + BEIJING_TIME_OFFSET_MS);
  return {
    year: beijingDate.getUTCFullYear(),
    month: beijingDate.getUTCMonth() + 1,
    day: beijingDate.getUTCDate(),
    hour: beijingDate.getUTCHours(),
    minute: beijingDate.getUTCMinutes()
  };
}

function getScheduledSnapshot() {
  const parts = getBeijingParts(new Date());
  const inCollectionWindow =
    parts.minute >= COLLECTION_MINUTE &&
    parts.minute < COLLECTION_MINUTE + COLLECTION_WINDOW_MINUTES;

  if (!SCHEDULED_BEIJING_HOURS.has(parts.hour) || !inCollectionWindow) {
    return null;
  }

  const beijingDate = `${parts.year}-${padDatePart(parts.month)}-${padDatePart(parts.day)}`;
  const snapshotAt = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour) - BEIJING_TIME_OFFSET_MS);

  return {
    snapshotAt: snapshotAt.toISOString(),
    beijingDate,
    beijingHour: parts.hour,
    isFinalSnapshot: parts.hour === 21
  };
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

function getEnabledProducts() {
  const configPath = path.join(process.cwd(), "owned-products.config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return (config.products || []).filter((product) => product.enabled !== false);
}

function parseAppStoreEntry(entry, index, chartType, snapshot) {
  const images = entry["im:image"] || [];
  const icon = images.length ? images[images.length - 1].label : "";

  return {
    snapshot_at: snapshot.snapshotAt,
    beijing_date: snapshot.beijingDate,
    beijing_hour: snapshot.beijingHour,
    is_final_snapshot: snapshot.isFinalSnapshot,
    country: "us",
    chart_type: chartType,
    rank: index + 1,
    app_id: entry.id?.attributes?.["im:id"] || "",
    app_name: entry["im:name"]?.label || "Unknown App",
    developer_name: entry["im:artist"]?.label || "Unknown Developer",
    icon_url: icon,
    app_store_url: entry.link?.attributes?.href || ""
  };
}

async function fetchChart(chart, snapshot) {
  let response;

  try {
    response = await fetch(chart.url);
  } catch (error) {
    throw new Error(`Apple RSS fetch failed for ${chart.chart_type}: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`Apple RSS ${chart.chart_type} failed: HTTP ${response.status}`);
  }

  let data;

  try {
    data = await response.json();
  } catch (error) {
    throw new Error(`Apple RSS JSON parse failed for ${chart.chart_type}: ${error.message}`);
  }

  const entries = Array.isArray(data.feed?.entry) ? data.feed.entry : [];

  return entries.map((entry, index) => parseAppStoreEntry(entry, index, chart.chart_type, snapshot));
}

async function supabaseRequest(path, options = {}) {
  const supabaseUrl = getRequiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const serviceKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const requestUrl = `${supabaseUrl}/rest/v1/${path}`;

  let response;

  try {
    response = await fetch(requestUrl, {
      ...options,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
  } catch (error) {
    throw new Error(`Supabase fetch failed for ${path}: ${error.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase request failed: HTTP ${response.status} ${errorText}`);
  }

  return response;
}

async function supabaseJson(path) {
  const response = await supabaseRequest(path);
  return response.json();
}

async function fetchOwnedProductProfiles(snapshot) {
  const products = getEnabledProducts().filter((product) => product.app_store_id);
  if (products.length === 0) {
    return [];
  }

  const productByAppId = new Map(products.map((product) => [product.app_store_id, product]));
  const ids = products.map((product) => product.app_store_id).join(",");
  const response = await fetch(`https://itunes.apple.com/lookup?id=${ids}&country=us`);

  if (!response.ok) {
    throw new Error(`Apple lookup failed: HTTP ${response.status}`);
  }

  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];

  return results.map((app) => {
    const appId = String(app.trackId || "");
    const product = productByAppId.get(appId);

    return {
      platform: "app_store",
      product_key: product?.key || appId,
      app_id: appId,
      app_name: app.trackName || product?.name || "Unknown App",
      developer_name: app.sellerName || app.artistName || "",
      icon_url: app.artworkUrl100 || app.artworkUrl512 || "",
      store_url: app.trackViewUrl || "",
      snapshot_at: snapshot.snapshotAt,
      beijing_date: snapshot.beijingDate,
      beijing_hour: snapshot.beijingHour,
      updated_at: new Date().toISOString()
    };
  });
}

async function upsertOwnedProductProfiles(rows) {
  if (rows.length === 0) {
    return;
  }

  await supabaseRequest(PROFILE_TABLE, {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(rows)
  });
}

async function getPreviousRows(chartType, snapshotAt) {
  const params = new URLSearchParams({
    select: "snapshot_at,rank,app_id",
    country: "eq.us",
    chart_type: `eq.${chartType}`,
    snapshot_at: `lt.${snapshotAt}`,
    order: "snapshot_at.desc,rank.asc",
    limit: "100"
  });

  const rows = await supabaseJson(`${SNAPSHOT_TABLE}?${params.toString()}`);
  if (rows.length === 0) {
    return [];
  }

  const previousSnapshotAt = rows[0].snapshot_at;
  return rows.filter((row) => row.snapshot_at === previousSnapshotAt);
}

function attachRankChanges(rows, previousRows) {
  const previousRankByAppId = new Map(previousRows.map((row) => [row.app_id, row.rank]));

  return rows.map((row) => {
    const previousRank = previousRankByAppId.get(row.app_id) || null;
    return {
      ...row,
      previous_rank: previousRank,
      rank_change: previousRank ? previousRank - row.rank : null
    };
  });
}

async function replaceChartSnapshot(chartType, snapshotAt, rows) {
  const query = new URLSearchParams({
    snapshot_at: `eq.${snapshotAt}`,
    country: "eq.us",
    chart_type: `eq.${chartType}`
  });

  await supabaseRequest(`${SNAPSHOT_TABLE}?${query.toString()}`, {
    method: "DELETE"
  });

  if (rows.length === 0) {
    return;
  }

  await supabaseRequest(SNAPSHOT_TABLE, {
    method: "POST",
    headers: {
      Prefer: "return=minimal"
    },
    body: JSON.stringify(rows)
  });
}

async function cleanupOldPartialSnapshots(currentBeijingDate) {
  const query = new URLSearchParams({
    beijing_date: `lt.${currentBeijingDate}`,
    is_final_snapshot: "eq.false"
  });

  await supabaseRequest(`${SNAPSHOT_TABLE}?${query.toString()}`, {
    method: "DELETE"
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

  const snapshot = getScheduledSnapshot();
  if (!snapshot) {
    return res.status(409).json({
      ok: false,
      error: "Collector can only run at Beijing time 00:10, 05:10, 09:10, 13:10, 17:10, 21:10"
    });
  }

  try {
    const results = [];

    for (const chart of CHARTS) {
      const rows = await fetchChart(chart, snapshot);
      const previousRows = await getPreviousRows(chart.chart_type, snapshot.snapshotAt);
      const rowsWithChanges = attachRankChanges(rows, previousRows);
      await replaceChartSnapshot(chart.chart_type, snapshot.snapshotAt, rowsWithChanges);
      results.push({
        chart_type: chart.chart_type,
        count: rowsWithChanges.length
      });
    }

    const ownedProfiles = await fetchOwnedProductProfiles(snapshot);
    await upsertOwnedProductProfiles(ownedProfiles);

    await cleanupOldPartialSnapshots(snapshot.beijingDate);

    return res.status(200).json({
      ok: true,
      snapshot_at: snapshot.snapshotAt,
      beijing_date: snapshot.beijingDate,
      beijing_hour: snapshot.beijingHour,
      is_final_snapshot: snapshot.isFinalSnapshot,
      owned_profiles: ownedProfiles.length,
      charts: results
    });
  } catch (error) {
    console.error("App Store collector failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
