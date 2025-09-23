// /api/ask2.js — usa /data/texto_base.js con fallback seguro
export const config = { runtime: "nodejs" };

const FALLBACK_TEXT = `\
Linea 1: fallback activo.
Linea 2: edita /data/texto_base.js para usar tu texto real.
`;

function normaliza(s = "") {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

let TEXT_CACHE; // undefined = aún no cargado, string = cargado
async function getText() {
  if (TEXT_CACHE !== undefined) return TEXT_CACHE;
  try {
    // Import dinámico DENTRO de la función (evita fallos de top-level)
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
  try {
    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      return res.status(405).json({ ok: false, error: "Solo GET o POST" });
    }
    const params = method === "POST" ? (req.body || {}) : (req.query || {});
    const { q = "", limit = "50", context = "0" } = params;

    const text = await getText();
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
          match.contexto = { desde: ini + 1, hasta: fin, fragmento: lines.slice(i
