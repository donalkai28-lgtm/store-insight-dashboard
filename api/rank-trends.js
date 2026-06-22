const fs = require("fs");
const path = require("path");

const PLATFORM_CONFIG = {
  ios: {
    table: "app_store_rank_snapshots",
    idField: "app_store_id"
  },
  gp: {
    table: "google_play_rank_snapshots",
    idField: "google_play_package"
  }
};

const RANGE_DAYS = {
  month: 30,
  quarter: 90,
  half: 180,
  year: 365
};

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function getConfig() {
  const configPath = path.join(process.cwd(), "owned-products.config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function getBeijingDateText(date) {
  const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const year = beijingDate.getUTCFullYear();
  const month = String(beijingDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(beijingDate.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCategorySeries(product, platform, config) {
  if (platform === "ios") {
    return (product.app_store_genres || []).slice(0, 2).map((genre, index) => ({
      key: `category_${index + 1}`,
      label: config.app_store_genres?.[genre]?.name || genre,
      chartType: `us_category_${genre}`
    }));
  }

  if (!product.google_play_category) {
    return [];
  }

  const categoryName =
    Object.entries(config.google_play_categories || []).find(([, category]) => category === product.google_play_category)?.[0] ||
    product.google_play_category;

  return [{
    key: "category",
    label: categoryName.replace(/^\w/, (char) => char.toUpperCase()),
    chartType: `us_category_${product.google_play_category}`
  }];
}

async function supabaseGet(pathname) {
  const supabaseUrl = getRequiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const serviceKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  const response = await fetch(`${supabaseUrl}/rest/v1/${pathname}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase request failed: HTTP ${response.status} ${errorText}`);
  }

  return response.json();
}

async function getTrendRows(platformConfig, item, appId, startDate, endDate) {
  const finalParams = new URLSearchParams({
    select: "beijing_date,rank,snapshot_at,is_final_snapshot",
    country: "eq.us",
    chart_type: `eq.${item.chartType}`,
    app_id: `eq.${appId}`,
    beijing_date: `gte.${startDate}`,
    is_final_snapshot: "eq.true",
    order: "beijing_date.asc"
  });
  finalParams.append("beijing_date", `lte.${endDate}`);

  const finalRows = await supabaseGet(`${platformConfig.table}?${finalParams.toString()}`);

  const latestCurrentParams = new URLSearchParams({
    select: "beijing_date,rank,snapshot_at,is_final_snapshot",
    country: "eq.us",
    chart_type: `eq.${item.chartType}`,
    app_id: `eq.${appId}`,
    beijing_date: `eq.${endDate}`,
    order: "snapshot_at.desc",
    limit: "1"
  });
  const latestCurrentRows = await supabaseGet(`${platformConfig.table}?${latestCurrentParams.toString()}`);

  const rowByDate = new Map(finalRows.map((row) => [row.beijing_date, row]));
  if (latestCurrentRows[0]) {
    rowByDate.set(latestCurrentRows[0].beijing_date, latestCurrentRows[0]);
  }

  return [...rowByDate.values()]
    .sort((a, b) => a.beijing_date.localeCompare(b.beijing_date))
    .map((row) => ({
      date: row.beijing_date,
      rank: row.rank,
      snapshot_at: row.snapshot_at,
      is_final_snapshot: row.is_final_snapshot
    }));
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const platform = req.query?.platform || "ios";
  const range = req.query?.range || "month";
  const productKey = req.query?.product_key || "";
  const platformConfig = PLATFORM_CONFIG[platform];

  if (!platformConfig) {
    return res.status(400).json({ ok: false, error: "Invalid platform" });
  }
  if (!RANGE_DAYS[range]) {
    return res.status(400).json({ ok: false, error: "Invalid range" });
  }

  try {
    const config = getConfig();
    const products = (config.products || []).filter((product) => product.enabled !== false);
    const product = products.find((item) => item.key === productKey) || products[0];
    const appId = product?.[platformConfig.idField] || "";

    if (!product || !appId) {
      return res.status(200).json({
        ok: true,
        product,
        platform,
        range,
        rows: []
      });
    }

    const endDate = getBeijingDateText(new Date());
    const start = new Date(`${endDate}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() - RANGE_DAYS[range] + 1);
    const startDate = start.toISOString().slice(0, 10);

    const seriesConfig = [
      { key: "games", label: "US游戏榜", chartType: "us_games" },
      ...getCategorySeries(product, platform, config)
    ];

    const series = await Promise.all(seriesConfig.map(async (item) => {
      const rows = await getTrendRows(platformConfig, item, appId, startDate, endDate);
      return {
        key: item.key,
        label: item.label,
        chart_type: item.chartType,
        rows
      };
    }));

    return res.status(200).json({
      ok: true,
      product: {
        key: product.key,
        name: product.name,
        app_id: appId
      },
      platform,
      range,
      rows: series[0]?.rows || [],
      series
    });
  } catch (error) {
    console.error("Rank trends API failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
