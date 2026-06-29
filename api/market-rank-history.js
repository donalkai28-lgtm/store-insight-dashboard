const BEIJING_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;
const PLATFORM_TABLES = {
  app_store: "app_store_rank_snapshots",
  google_play: "google_play_rank_snapshots"
};

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function getBeijingDateText(date) {
  const d = new Date(date.getTime() + BEIJING_TIME_OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function supabaseGet(path) {
  const url = getRequiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const key = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase error: HTTP ${response.status} ${text}`);
  }
  return response.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const appId = req.query?.app_id || "";
  const platform = req.query?.platform || "app_store";
  const table = PLATFORM_TABLES[platform];

  if (!appId || !table) {
    return res.status(400).json({ ok: false, error: "Invalid params" });
  }

  try {
    const endDate = getBeijingDateText(new Date());
    const startObj = new Date(`${endDate}T00:00:00.000Z`);
    startObj.setUTCDate(startObj.getUTCDate() - 29);
    const startDate = startObj.toISOString().slice(0, 10);

    const finalParams = new URLSearchParams({
      select: "beijing_date,rank",
      country: "eq.us",
      chart_type: "eq.us_games",
      app_id: `eq.${appId}`,
      beijing_date: `gte.${startDate}`,
      is_final_snapshot: "eq.true",
      order: "beijing_date.asc"
    });
    finalParams.append("beijing_date", `lte.${endDate}`);

    const todayParams = new URLSearchParams({
      select: "beijing_date,rank",
      country: "eq.us",
      chart_type: "eq.us_games",
      app_id: `eq.${appId}`,
      beijing_date: `eq.${endDate}`,
      order: "snapshot_at.desc",
      limit: "1"
    });

    const [finalRows, todayRows] = await Promise.all([
      supabaseGet(`${table}?${finalParams.toString()}`),
      supabaseGet(`${table}?${todayParams.toString()}`)
    ]);

    const rowByDate = new Map(finalRows.map((r) => [r.beijing_date, r.rank]));
    if (todayRows[0]) {
      rowByDate.set(todayRows[0].beijing_date, todayRows[0].rank);
    }

    const rows = Array.from(rowByDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, rank]) => ({ date, rank }));

    return res.status(200).json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
