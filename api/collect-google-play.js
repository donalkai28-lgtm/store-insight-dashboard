const CHARTS = [
  {
    chart_type: "us_games",
    category: "GAME"
  },
  {
    chart_type: "us_apps",
    category: "APPLICATION"
  }
];

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function getSnapshotHour() {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  return date.toISOString();
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

function parseGooglePlayApp(app, index, chartType, snapshotAt) {
  return {
    snapshot_at: snapshotAt,
    country: "us",
    chart_type: chartType,
    rank: index + 1,
    app_id: app.appId || "",
    app_name: app.title || "Unknown App",
    developer_name: app.developer || "Unknown Developer",
    icon_url: app.icon || "",
    play_store_url: app.url || (app.appId ? `https://play.google.com/store/apps/details?id=${app.appId}` : ""),
    score: typeof app.score === "number" ? app.score : null
  };
}

async function fetchChart(chart, snapshotAt) {
  let apps;

  try {
    const googlePlayScraper = await import("google-play-scraper");
    const gplay = googlePlayScraper.default || googlePlayScraper;

    apps = await gplay.list({
      collection: "TOP_FREE",
      category: chart.category,
      country: "us",
      lang: "en",
      num: 100,
      fullDetail: false
    });
  } catch (error) {
    throw new Error(`Google Play fetch failed for ${chart.chart_type}: ${error.message}`);
  }

  return apps.map((app, index) => parseGooglePlayApp(app, index, chart.chart_type, snapshotAt));
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

async function replaceChartSnapshot(chartType, snapshotAt, rows) {
  const query = new URLSearchParams({
    snapshot_at: `eq.${snapshotAt}`,
    country: "eq.us",
    chart_type: `eq.${chartType}`
  });

  await supabaseRequest(`google_play_rank_snapshots?${query.toString()}`, {
    method: "DELETE"
  });

  if (rows.length === 0) {
    return;
  }

  await supabaseRequest("google_play_rank_snapshots", {
    method: "POST",
    headers: {
      Prefer: "return=minimal"
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

  const snapshotAt = getSnapshotHour();

  try {
    const results = [];

    for (const chart of CHARTS) {
      const rows = await fetchChart(chart, snapshotAt);
      await replaceChartSnapshot(chart.chart_type, snapshotAt, rows);
      results.push({
        chart_type: chart.chart_type,
        count: rows.length
      });
    }

    return res.status(200).json({
      ok: true,
      snapshot_at: snapshotAt,
      charts: results
    });
  } catch (error) {
    console.error("Google Play collector failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
