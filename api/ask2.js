// /api/ask2.js — búsqueda sin imports (texto inline)
export const config = { runtime: "nodejs" };

const TEXTO_BASE = `\
Linea 1: prueba de percentiles y gauss.
Linea 2: otra linea con Percentiles de ejemplo.
Linea 3: nada que ver aqui.
`;

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

    const text = TEXTO_BASE;
    const lines = text.split(/\r?\n/);

    if (!q.trim()) {
      return res.sta
