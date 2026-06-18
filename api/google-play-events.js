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

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const latestRows = await supabaseGet("google_play_events?select=beijing_date&order=beijing_date.desc&limit=1");
    const latestDate = latestRows[0]?.beijing_date || null;

    if (!latestDate) {
      return res.status(200).json({
        ok: true,
        beijing_date: null,
        rows: []
      });
    }

    const params = new URLSearchParams({
      select: "app_id,product_key,app_name,event_title,relative_end_time,estimated_end_date,image_url,event_url,collected_at,beijing_date",
      beijing_date: `eq.${latestDate}`,
      order: "estimated_end_date.asc.nullslast,app_name.asc",
      limit: "20"
    });

    const rows = await supabaseGet(`google_play_events?${params.toString()}`);

    return res.status(200).json({
      ok: true,
      beijing_date: latestDate,
      rows
    });
  } catch (error) {
    console.error("Google Play events API failed:", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
