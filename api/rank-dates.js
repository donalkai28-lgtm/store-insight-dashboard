const TABLES = ["app_store_rank_snapshots", "google_play_rank_snapshots"];

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
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

async function getTableDates(table) {
  const params = new URLSearchParams({
    select: "beijing_date",
    country: "eq.us",
    chart_type: "eq.us_games",
    order: "beijing_date.desc",
    limit: "2000"
  });

  const rows = await supabaseGet(`${table}?${params.toString()}`);
  return rows.map((row) => row.beijing_date).filter(Boolean);
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const results = await Promise.all(TABLES.map(getTableDates));
    const dates = [...new Set(results.flat())].sort();

    return res.status(200).json({
      ok: true,
      dates,
      latest_date: dates[dates.length - 1] || null
    });
  } catch (error) {
    console.error("Rank dates API failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
