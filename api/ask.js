// Serverless Function en Vercel (Node.js)
// GET /api/ask?q=...
// - q=ping  -> {ok:true, pong:true}
// - q=file  -> intenta leer /public/datos/decimo.csv y devuelve conteo de filas
// - otro q  -> eco simple

const fs = require("fs");
const path = require("path");

module.exports = async (req, res) => {
  try {
    // Habilitar CORS básico (útil si lo vas a llamar desde Wix o iframe)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.status(204).end();

    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const q = (req.query.q || "").toString().trim();

    if (q === "ping") {
      return res.status(200).json({ ok: true, pong: true, hint: "¡Todo bien! 🚀" });
    }

    if (q === "file") {
      // Lee un CSV colocado en /public/datos/decimo.csv
      const csvPath = path.join(process.cwd(), "public", "datos", "decimo.csv");
      if (!fs.existsSync(csvPath)) {
        return res.status(200).json({
          ok: true,
          file: "public/datos/decimo.csv",
          exists: false,
          rows: 0,
          note: "No se encontró el archivo. Crea la carpeta /public/datos/ y pon decimo.csv"
        });
      }
      const raw = fs.readFileSync(csvPath, "utf8");
      const rows = raw.split(/\r?\n/).filter((r) => r.trim().length > 0).length;
      return res.status(200).json({
        ok: true,
        file: "public/datos/decimo.csv",
        exists: true,
        rows
      });
    }

    // Respuesta por defecto (eco)
    return res.status(200).json({
      ok: true,
      q,
      msg: "Endpoint vivo. Usa ?q=ping o ?q=file para pruebas."
    });
  } catch (err) {
    console.error("API /ask error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Internal error" });
  }
};
