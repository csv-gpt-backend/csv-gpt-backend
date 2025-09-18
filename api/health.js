export default async function handler(req, res) {
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers.host;
    const csvUrl = `${proto}://${host}/datos/decimo.csv`;

    // CSV accesible
    let csvOK = false;
    try {
      const r = await fetch(csvUrl);
      csvOK = r.ok;
    } catch {}

    res.status(200).json({
      ok: true,
      hasOpenAIKey: !!(process.env.OPENAI_API_KEY || process.env.CLAVE_API_DE_OPENAI || process.env["CLAVE API DE OPENAI"]),
      csvUrl,
      csvOK
    });
  } catch (e) {
    res.status(200).json({ ok:false, error: String(e) });
  }
}
