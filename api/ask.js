// /api/ask.js — TXT search (GET/POST) con CORS y fallback seguro
export const config = { runtime: "nodejs" };

// --- CORS (útil si llamas desde otro dominio, ej. Wix) ---
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// --- Normaliza texto (quita tildes y pasa a minúsculas) ---
function normaliza(s = "") {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// --- Carga del texto base con fallback y caché ---
const FALLBACK_TEXT = `\
[AVISO] No se pudo cargar /data/texto_base.js.
Revisa que esté exportando:  export const TEXTO_BASE = String.raw\`...\`;
y que CIERRE con el backtick + punto y coma: \`;
`;

let TEXT_CACHE; // undefined = aún no cargado; string = cargado
async function getText() {
  if (TEXT_CACHE !== undefined) return TEXT_CACHE;
  try {
    // Import dinámico dentro de función (evita errores en top-level)
    const mod = await import("../data/texto_base.js");
    const t = String(mod?.TEXTO_BASE ?? "");
    TEXT_CACHE = t.length ? t : FALLBACK_TEXT;
  } catch (e) {
    console.error("No se pudo importar /data/texto_base.js:", e);
    TEXT_CACHE = FALLBACK_TEXT;
  }
  return TEXT_CACHE;
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      return res.status(405).json({ ok: false, error: "Solo GET o POST" });
    }

    // Parámetros: GET -> query, POST -> body
    const params = method === "POST" ? (req.body || {}) : (req.query || {});
    const { q = "", limit = "50", context = "0" } = params;

    const text = await getText();
    const lines = text.split(/\r?\n/);

    // Sin query => devolver texto completo
    if (!String(q).trim()) {
      return res.status(200).json({
        ok: true,
        endpoint: "ask",
        mode: "txt-full",
        n_lineas: lines.length,
        texto: text
      });
    }

    // Búsqueda
    const qn = normaliza(String(q));
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
          match.contexto = {
            desde: ini + 1,
            hasta: fin,
            fragmento: lines.slice(ini, fin)
          };
        }
        resultados.push(match);
        if (resultados.length >= maxRes) break;
      }
    }

    return res.status(200).json({
      ok: true,
      endpoint: "ask",
      mode: "txt-search",
      query: q,
      total_encontrados: resultados.length,
      n_lineas: lines.length,
      resultados
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      error: "Error interno en /api/ask",
      detalle: String(err?.message || err)
    });
  }
}
