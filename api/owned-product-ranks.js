const fs = require("fs");
const path = require("path");

const BASE_CHART_TYPES = ["us_games", "us_apps"];
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

function getConfig() {
  const configPath = path.join(process.cwd(), "owned-products.config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function getEnabledProducts(config) {
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

function getChartTypes(platform, products) {
  if (platform === "app_store") {
    const categoryTypes = new Set();
    products.forEach((product) => {
      (product.app_store_genres || []).forEach((genre) => {
        categoryTypes.add(`us_category_${genre}`);
      });
    });
    return [...BASE_CHART_TYPES, ...categoryTypes];
  }

  const categoryTypes = new Set();
  products.forEach((product) => {
    if (product.google_play_category) {
      categoryTypes.add(`us_category_${product.google_play_category}`);
    }
  });

  return [...BASE_CHART_TYPES, ...categoryTypes];
}

async function getOwnedProfiles(platform, products) {
  const productKeys = products.map((product) => product.key).filter(Boolean);
  if (productKeys.length === 0) {
    return new Map();
  }

  const params = new URLSearchParams({
    select: "product_key,app_name,developer_name,icon_url,store_url,app_id",
    platform: `eq.${platform}`,
    product_key: `in.(${productKeys.join(",")})`
  });

  const rows = await supabaseGet(`owned_product_profiles?${params.toString()}`);
  return new Map(rows.map((row) => [row.product_key, row]));
}

function getAppStoreCategoryRanks(product, config, rankLookupByChart, appId) {
  return (product.app_store_genres || []).slice(0, 2).map((genre) => ({
    rank: appId ? rankLookupByChart[`us_category_${genre}`]?.get(appId)?.rank || null : null,
    label: config.app_store_genres?.[genre]?.name || genre
  }));
}

function getGooglePlayCategoryRank(product, config, rankLookupByChart, appId) {
  const categoryName =
    Object.entries(config.google_play_categories || {}).find(([, category]) => category === product.google_play_category)?.[0] ||
    product.google_play_category ||
    "";

  return {
    rank: appId ? rankLookupByChart[`us_category_${product.google_play_category}`]?.get(appId)?.rank || null : null,
    label: categoryName ? categoryName.replace(/^\w/, (char) => char.toUpperCase()) : ""
  };
}

function getBestCategoryRank(row) {
  const categoryRanks = [row.ranks.us_category_1, row.ranks.us_category_2, row.ranks.us_category]
    .filter(Boolean)
    .map((rankInfo) => rankInfo.rank)
    .filter((rank) => typeof rank === "number");

  if (categoryRanks.length === 0) {
    return null;
  }

  return Math.min(...categoryRanks);
}

function sortOwnedRows(rows) {
  return rows.sort((a, b) => {
    if (a.is_unlisted !== b.is_unlisted) {
      return a.is_unlisted ? 1 : -1;
    }

    const aGameRank = a.ranks.us_games;
    const bGameRank = b.ranks.us_games;

    if (aGameRank && bGameRank) {
      return aGameRank - bGameRank;
    }
    if (aGameRank) {
      return -1;
    }
    if (bGameRank) {
      return 1;
    }

    const aCategoryRank = getBestCategoryRank(a);
    const bCategoryRank = getBestCategoryRank(b);

    if (aCategoryRank && bCategoryRank) {
      return aCategoryRank - bCategoryRank;
    }
    if (aCategoryRank) {
      return -1;
    }
    if (bCategoryRank) {
      return 1;
    }

    return a.name.localeCompare(b.name);
  });
}

function buildOwnedRows(products, platform, chartRowsByType, profileByProductKey, config, chartTypes) {
  const platformConfig = PLATFORM_CONFIG[platform];
  const rankLookupByChart = Object.fromEntries(
    chartTypes.map((chartType) => [
      chartType,
      new Map((chartRowsByType[chartType] || []).map((row) => [row.app_id, row]))
    ])
  );

  const getFallbackStoreUrl = (appId) => {
    if (!appId) {
      return "";
    }

    if (platform === "app_store") {
      return `https://apps.apple.com/us/app/id${appId}`;
    }

    return `https://play.google.com/store/apps/details?id=${appId}&gl=US&hl=en`;
  };

  const rows = products.map((product) => {
    const appId = product[platformConfig.idField] || "";
    const gameRow = appId ? rankLookupByChart.us_games.get(appId) : null;
    const appRow = appId ? rankLookupByChart.us_apps.get(appId) : null;
    const sourceRow = gameRow || appRow || null;
    const profile = profileByProductKey.get(product.key) || null;
    const hasProfileInfo = Boolean(profile?.store_url || profile?.icon_url || profile?.developer_name);
    const isUnlisted = !appId || (!sourceRow && !hasProfileInfo);
    const appStoreCategoryRanks =
      platform === "app_store" ? getAppStoreCategoryRanks(product, config, rankLookupByChart, appId) : [];

    return {
      key: product.key,
      name: profile?.app_name || product.name,
      app_id: appId,
      developer_name: sourceRow?.developer_name || profile?.developer_name || "",
      icon_url: sourceRow?.icon_url || profile?.icon_url || "",
      url: sourceRow?.app_store_url || sourceRow?.play_store_url || profile?.store_url || getFallbackStoreUrl(appId),
      ranks: {
        us_games: gameRow?.rank || null,
        us_apps: appRow?.rank || null,
        us_category_1: appStoreCategoryRanks[0] || null,
        us_category_2: appStoreCategoryRanks[1] || null,
        us_category: platform === "google_play" ? getGooglePlayCategoryRank(product, config, rankLookupByChart, appId) : null
      },
      missing_id: !appId,
      is_unlisted: isUnlisted
    };
  });

  return sortOwnedRows(rows);
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
    const config = getConfig();
    const products = getEnabledProducts(config);
    const chartRowsByType = {};
    const profileByProductKey = await getOwnedProfiles(platform, products);
    const chartTypes = getChartTypes(platform, products);

    for (const chartType of chartTypes) {
      chartRowsByType[chartType] = await getLatestChartRows(PLATFORM_CONFIG[platform], chartType, req.query?.date);
    }

    return res.status(200).json({
      ok: true,
      platform,
      rows: buildOwnedRows(products, platform, chartRowsByType, profileByProductKey, config, chartTypes),
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
