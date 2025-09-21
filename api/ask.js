// api/ask.js  (ESM)

export const config = { runtime: "nodejs" };

// ======= Ajustes =======
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const DEFAULT_SOURCES = [
  "datos/decimo.csv",
  "documentos/lexium.pdf",
  "documentos/evaluaciones.pdf",
  "documentos/emocionales.pdf",
];

// Rutas bloqueadas (no servir estos recursos)
const BLOCKLIST = new Set([
  "documentos/auxiliar.pdf",
  "/documentos/auxiliar.pdf",
]);

// ======= Utils =======
function safePathParam(p = "") {
  // Normaliza y valida rutas públicas; evita .. y // y backslashes
  const s = String(p || "").trim().replace(/\\/g, "/");
  if (!s || s.startsWith("http")) return ""; // no URLs externas aquí
  if (s.includes("..")) return "";
  // Solo /, letras, números, guion, guion bajo, punto
  if (!/^\/?[a-zA-Z0-9._/-]+$/.test(s)) return "";
  return s.replace(/^\/+/, ""); // sin leading slash
}

function getPublicBase(req) {
  // Base pública del deployment actual
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  return `${proto}://${host}/`;
}

async function fetchPublic(base, relPath) {
  const url = new URL(relPath, base).toString();
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    throw new Error(`No pude leer ${url} (HTTP ${r.status})`);
  }
  return r;
}

async function loadPdfParse() {
  // Carga dinámica para pdf-parse (evita issues en build)
  const mod = await import("pdf-parse");
  return mod.default || mod;
}

async function toTextFromResponse(res, relPath) {
  // Convierte un recurso (pdf/csv/txt) a texto
  const lc = relPath.toLowerCase();

  if (lc.endsWith(".pdf")) {
    const buf = Buffer.from(await res.arrayBuffer());
    const pdfParse = await loadPdfParse();
    const data = await pdfParse(buf);
    return data.text || "";
  }

  // csv, txt, html -> texto plano
  const txt = await res.text();
  return txt;
}

function buildSystemPrompt() {
  return `
Eres una analista educativa clara y ejecutiva, en español (LatAm/México).
Sigue estas reglas:
- Usa los datos proporcionados (CSV/PDF) para responder con precisión.
- Si se piden cálculos (promedios, varianzas, correlaciones, ranking, etc.), hazlos.
- Si se piden tablas/listas, responde en CSV con encabezados claros.
- No menciones "no puedo calcular" ni "no tengo acceso"; realiza el mejor esfuerzo sobre el corpus dado.
- No repitas * o marcadores; describe los hallazgos directo y con claridad.
- Voz pensada para ser leída por una locutora mujer en español latino.
`.trim();
}

async function callOpenAI(apiKey, model, userQuery, corpusList) {
  // Construye mensajes para Chat Completions
  const maxCorpus = 18000; // recorte defensivo
  let joined = corpusList
    .map((c) => `=== FUENTE: ${c.src}\n${c.text}`)
    .join("\n\n");

  if (joined.length > maxCorpus) {
    joined = joined.slice(0, maxCorpus) + "\n[...recortado por longitud...]";
  }

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    {
      role: "user",
      content:
        `Pregunta del usuario:\n${userQuery}\n\n` +
        `Corpus (texto de fuentes):\n${joined}\n\n` +
        `Instrucciones:\n- Devuelve primero la explicación textual.\n` +
        `- Si corresponde, agrega una tabla en CSV con encabezados adecuados.\n`,
    },
  ];

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      max_tokens: 1200,
    }),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`OpenAI error ${r.status}: ${errText}`);
    }

  const j = await r.json();
  const text =
    j?.choices?.[0]?.message?.content?.trim() ||
    "No se obtuvo texto de la IA.";
  return text;
}

// ======= Handler =======
export default async function handler(req, res) {
  try {
    const qRaw = (req.query.q || req.body?.q || "").toString().trim();

    // 1) Salud y ping
    if (!qRaw) {
      return res.status(400).json({ error: "Falta el parámetro q" });
    }
    if (qRaw.toLowerCase() === "ping") {
      return res.status(200).json({ texto: "pong" });
    }

    // 2) API Key y modelo
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APIKEY;
    if (!OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ error: "Falta OPENAI_API_KEY en Vercel" });
    }
    const MODEL = process.env.OPENAI_MODEL || DEFAULT_MODEL;

    // 3) Arma fuentes
    let srcs = req.query.src || req.body?.src || DEFAULT_SOURCES;
    if (!Array.isArray(srcs)) srcs = [srcs];
    srcs = srcs
      .map((s) => safePathParam(s))
      .filter((s) => s && !BLOCKLIST.has(s));

    // 4) Lee fuentes desde /public
    const publicBase = getPublicBase(req);
    const corpus = [];
    for (const rel of srcs) {
      try {
        const r = await fetchPublic(publicBase, rel);
        const text = await toTextFromResponse(r, rel);
        if (text && text.trim().length > 0) {
          corpus.push({ src: rel, text });
        }
      } catch (e) {
        // No hacemos throw: continuamos con las demás fuentes
        corpus.push({
          src: rel,
          text: `[[No se pudo leer ${rel}: ${e.message}]]`,
        });
      }
    }

    // 5) Llama a OpenAI
    const texto = await callOpenAI(OPENAI_API_KEY, MODEL, qRaw, corpus);

    return res.status(200).json({
      texto,
      fuentes: srcs,
      formato: "texto",
    });
  } catch (err) {
    return res.status(500).json({
      error: String(err?.message || err),
    });
  }
}
