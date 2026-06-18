const CHART_TYPES = new Set(["us_games", "us_apps"]);

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

  const start = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    throw new Error("Invalid date parameter");
  }

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

async function supabaseGet(path) {
  const supabaseUrl = getRequiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const serviceKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  let response;

  try {
    response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`
      }
    });
  } catch (error) {
    throw new Error(`Supabase fetch failed for ${path}: ${error.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase request failed: HTTP ${response.status} ${errorText}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Supabase JSON parse failed for ${path}: ${error.message}`);
  }
}

async function getLatestRows(chartType, dateText) {
  const params = new URLSearchParams({
    select: "snapshot_at,rank,app_id,app_name,developer_name,icon_url,play_store_url,score",
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

  const rows = await supabaseGet(`google_play_rank_snapshots?${params.toString()}`);
  if (rows.length === 0) {
    return [];
  }

  const latestSnapshotAt = rows[0].snapshot_at;
  return rows.filter((row) => row.snapshot_at === latestSnapshotAt).sort((a, b) => a.rank - b.rank);
}

async function getPreviousRows(chartType, snapshotAt) {
  if (!snapshotAt) {
    return [];
  }

  const params = new URLSearchParams({
    select: "snapshot_at,rank,app_id",
    country: "eq.us",
    chart_type: `eq.${chartType}`,
    snapshot_at: `lt.${snapshotAt}`,
    order: "snapshot_at.desc,rank.asc",
    limit: "100"
  });

  const rows = await supabaseGet(`google_play_rank_snapshots?${params.toString()}`);
  if (rows.length === 0) {
    return [];
  }

  const previousSnapshotAt = rows[0].snapshot_at;
  return rows.filter((row) => row.snapshot_at === previousSnapshotAt).sort((a, b) => a.rank - b.rank);
}

function attachRankChanges(rows, previousRows) {
  const previousRankByAppId = new Map(previousRows.map((row) => [row.app_id, row.rank]));

  return rows.map((row) => {
    const previousRank = previousRankByAppId.get(row.app_id) || null;
    const rankChange = previousRank ? previousRank - row.rank : null;

    return {
      ...row,
      previous_rank: previousRank,
      rank_change: rankChange
    };
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const chartType = req.query?.chart_type || "us_games";

  if (!CHART_TYPES.has(chartType)) {
    return res.status(400).json({ ok: false, error: "Invalid chart_type" });
  }

  try {
    const rows = await getLatestRows(chartType, req.query?.date);
    const snapshotAt = rows[0]?.snapshot_at || null;
    const previousRows = await getPreviousRows(chartType, snapshotAt);
    const previousSnapshotAt = previousRows[0]?.snapshot_at || null;

    return res.status(200).json({
      ok: true,
      chart_type: chartType,
      snapshot_at: snapshotAt,
      previous_snapshot_at: previousSnapshotAt,
      rows: attachRankChanges(rows, previousRows)
    });
  } catch (error) {
    console.error("Google Play ranks API failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
