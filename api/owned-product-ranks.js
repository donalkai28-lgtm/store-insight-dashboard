const fs = require("fs");
const path = require("path");

const CHART_TYPES = ["us_games", "us_apps"];
const BEIJING_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;
const PLATFORM_CONFIG = {
  app_store: {
    table: "app_store_rank_snapshots",
    idField: "app_store_id",
    select: "snapshot_at,rank,app_id,app_name,developer_name,icon_url,app_store_url"
  },
  google_play: {
    table: "google_play_rank_snapshots",
    idField: "google_play_package",
    select: "snapshot_at,rank,app_id,app_name,developer_name,icon_url,play_store_url"
  }
};

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function getDateRange(dateText) {
  if (!dateText) {
    return null;
  }

  const [year, month, day] = dateText.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error("Invalid date parameter");
  }

  const start = new Date(Date.UTC(year, month - 1, day) - BEIJING_TIME_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function getEnabledProducts() {
  const configPath = path.join(process.cwd(), "owned-products.config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return (config.products || []).filter((product) => product.enabled !== false);
}

async function supabaseGet(pathname) {
  const supabaseUrl = getRequiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const serviceKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  let response;

  try {
    response = await fetch(`${supabaseUrl}/rest/v1/${pathname}`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`
      }
    });
  } catch (error) {
    throw new Error(`Supabase fetch failed for ${pathname}: ${error.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase request failed: HTTP ${response.status} ${errorText}`);
  }

  return response.json();
}

async function getLatestChartRows(platformConfig, chartType, dateText) {
  const params = new URLSearchParams({
    select: platformConfig.select,
    country: "eq.us",
    chart_type: `eq.${chartType}`,
    order: "snapshot_at.desc,rank.asc",
    limit: "100"
  });

  const dateRange = getDateRange(dateText);
  if (dateRange) {
    params.set("snapshot_at", `gte.${dateRange.start}`);
    params.append("snapshot_at", `lt.${dateRange.end}`);
  }

  const rows = await supabaseGet(`${platformConfig.table}?${params.toString()}`);
  if (rows.length === 0) {
    return [];
  }

  const latestSnapshotAt = rows[0].snapshot_at;
  return rows.filter((row) => row.snapshot_at === latestSnapshotAt).sort((a, b) => a.rank - b.rank);
}

function buildOwnedRows(products, platform, chartRowsByType) {
  const platformConfig = PLATFORM_CONFIG[platform];
  const rankLookupByChart = Object.fromEntries(
    CHART_TYPES.map((chartType) => [
      chartType,
      new Map(chartRowsByType[chartType].map((row) => [row.app_id, row]))
    ])
  );

  return products.map((product) => {
    const appId = product[platformConfig.idField] || "";
    const gameRow = appId ? rankLookupByChart.us_games.get(appId) : null;
    const appRow = appId ? rankLookupByChart.us_apps.get(appId) : null;
    const sourceRow = gameRow || appRow || null;

    return {
      key: product.key,
      name: product.name,
      app_id: appId,
      developer_name: sourceRow?.developer_name || "",
      icon_url: sourceRow?.icon_url || "",
      url: sourceRow?.app_store_url || sourceRow?.play_store_url || "",
      ranks: {
        us_games: gameRow?.rank || null,
        us_apps: appRow?.rank || null,
        us_category_1: null,
        us_category_2: null,
        us_category: null
      },
      missing_id: !appId
    };
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const platform = req.query?.platform || "app_store";
  if (!PLATFORM_CONFIG[platform]) {
    return res.status(400).json({ ok: false, error: "Invalid platform" });
  }

  try {
    const products = getEnabledProducts();
    const chartRowsByType = {};

    for (const chartType of CHART_TYPES) {
      chartRowsByType[chartType] = await getLatestChartRows(PLATFORM_CONFIG[platform], chartType, req.query?.date);
    }

    return res.status(200).json({
      ok: true,
      platform,
      rows: buildOwnedRows(products, platform, chartRowsByType),
      snapshots: {
        us_games: chartRowsByType.us_games[0]?.snapshot_at || null,
        us_apps: chartRowsByType.us_apps[0]?.snapshot_at || null
      }
    });
  } catch (error) {
    console.error("Owned product ranks API failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
