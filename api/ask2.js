// /api/ask2.js — búsqueda con import protegido
export const config = { runtime: "nodejs" };

let TEXTO_BASE = "CARGA_FALLIDA";
try {
  const mod = await import("../data/texto_base.js"); // ESM dinámico
  TEXTO_BASE = String(mod?.TEXTO_BASE ?? "VACIO");
} catch (e) {
  console.error("Error importando /data/texto_base.js:", e);
}

function normaliza(s = "") {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export default async function handler(req, res) {
  try {
    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      return res.status(405).json({ ok: false, error: "Solo GET o POST" });
    }
    const params = method === "POST" ? (req.body || {}) : (req.query || {});
    const { q = "", limit = "50", context = "0" } = params;

    if (TEXTO_BASE === "CARGA_FALLIDA") {
      return res.status(200).json({
        ok: false,
        error: "No se pudo cargar /data/texto_base.js (revisa backticks y que cierre el template)."
      });
    }

    const text = TEXTO_BASE;
    const lines = text.split(/\r?\n/);

    if (!q.trim()) {
      return res.status(200).json({
        ok: true, endpoint: "ask2", mode: "txt-full",
        n_lineas: lines.length, texto: text
      });
    }

    const qn = normaliza(q);
    const maxRes = Math.max(1, Number(limit) || 50);
    const ctx = Math.max(0, Number(context) || 0);

    const resultados = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (normaliza(ln).includes(qn)) {
        const match = { linea: i + 1, texto: ln };
        if (ctx) {
          const ini = Math.max(0, i - ctx);
          const fin = Math.min(lines.length, i + ctx + 1);
          match.contexto = { desde: ini + 1, hasta: fin, fragmento: lines.slice(ini, fin) };
        }
        resultados.push(match);
        if (resultados.length >= maxRes) break;
      }
    }

    return res.status(200).json({
      ok: true, endpoint: "ask2", mode: "txt-search",
      query: q, total_encontrados: resultados.length,
      n_lineas: lines.length, resultados
    });
  } catch (err) {
    res.status(200).json({ ok: false, where: "ask2-imported", error: String(err?.message || err) });
  }
}
