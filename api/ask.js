// api/ask.js — CommonJS
// Lee CSV/PDF del /public, combina, manda a OpenAI y devuelve respuesta en español.
// Mantiene memoria de conversación por 15 minutos. Ignora asteriscos en la salida.

const pdfParse = require("pdf-parse");

// ==== Config ====
const SESSION_MINUTES = 15;              // memoria por sesión
const MAX_TURNS_IN_CONTEXT = 8;          // límite de turnos de historial
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // cambia si quieres
const TEMP = 0.1;                        // precisión alta, poca creatividad

// Archivos disponibles en /public
const DEFAULT_SOURCES = [
  "datos/decimo.csv",
  "documentos/lexium.pdf",
  "documentos/evaluaciones.pdf",
  "documentos/emocionales.pdf",
];

// Blocklist de rutas fantasma si aparece “auxiliar.pdf”
const BLOCKLIST = new Set([
  "documentos/auxiliar.pdf",
  "/documentos/auxiliar.pdf",
]);

// Cache simple (fuente -> { ts, text })
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

// Memoria por sesión simple en RAM (sessionId -> { turns: [{role,content}], ts })
const sessions = new Map();

function pruneCache() {
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (now - v.ts > CACHE_MS) cache.delete(k);
  }
}
setInterval(pruneCache, 60_000).unref();

// ====== Utilidades ======
function getPublicBase(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  return `${proto}://${host}/`;
}

async function fetchAsBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No pude leer ${url} (${r.status})`);
  const arr = await r.arrayBuffer();
  return Buffer.from(arr);
}

async function fetchAsText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No pude leer ${url} (${r.status})`);
  return await r.text();
}

function parseCSVSmart(text) {
  // Parser sencillo que intenta ;, luego , como separador.
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };

  let sep = ";";
  if (lines[0].split(",").length > lines[0].split(";").length) sep = ",";

  const headers = lines[0].split(sep).map(s => s.trim());
  const rows = lines.slice(1).map(line => {
    const cols = line.split(sep).map(s => s.trim());
    const row = {};
    headers.forEach((h, i) => { row[h || `col${i}`] = cols[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

async function readSource(publicBase, path) {
  // cache
  const key = publicBase + path;
  const inCache = cache.get(key);
  const now = Date.now();
  if (inCache && (now - inCache.ts < CACHE_MS)) {
    return inCache.text;
  }

  const lower = path.toLowerCase();
  let text = "";

  if (lower.endsWith(".pdf")) {
    const buf = await fetchAsBuffer(publicBase + path);
    const pdf = await pdfParse(buf);
    text = (pdf.text || "").trim();
  } else if (lower.endsWith(".csv")) {
    const csvText = await fetchAsText(publicBase + path);
    const parsed = parseCSVSmart(csvText);
    // compactación a CSV otra vez, para mandar al modelo sin ruido extra
    const compact = [
      `# CSV: ${path}`,
      parsed.headers.join(", "),
      ...parsed.rows.map(row => parsed.headers.map(h => row[h]).join(", ")),
    ].join("\n");
    text = compact;
  } else if (lower.endsWith(".txt") || lower.endsWith(".md")) {
    text = await fetchAsText(publicBase + path);
  } else {
    // si llega cualquier otro, lo intentamos como texto
    text = await fetchAsText(publicBase + path);
  }

  cache.set(key, { ts: now, text });
  return text;
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  const cutoff = SESSION_MINUTES * 60;
  const now = nowSec();
  if (!s || (now - s.ts > cutoff)) {
    // nueva sesión
    const fresh = { turns: [], ts: now };
    sessions.set(sessionId, fresh);
    return fresh;
  }
  s.ts = now; // refresca
  return s;
}

function pushTurn(session, role, content) {
  session.turns.push({ role, content });
  while (session.turns.length > MAX_TURNS_IN_CONTEXT) session.turns.shift();
}

function sanitizeOutput(s) {
  // Quita asteriscos y espacios raros, y evita frases prohibidas de “no puedo…”
  let t = String(s || "");
  t = t.replace(/\*/g, "");   // ignora asteriscos
  // (No forzamos cambios de contenido; solo quitamos asteriscos como pediste)
  return t;
}

async function callOpenAI(apiKey, model, messages) {
  // Node18 trae fetch. Usamos la API REST oficial de Chat Completions.
  const body = {
    model,
    temperature: TEMP,
    max_tokens: 1500,
    messages
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  const choice = data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content || "";
  return content;
}

// ====== Handler ======
module.exports = async (req, res) => {
  try {
    // 1) Salud
    const qRaw = (req.query.q || req.body?.q || "").toString().trim();
    if (!qRaw) {
      return res.status(400).json({ error: "Falta el parámetro q" });
    }
    if (qRaw.toLowerCase() === "ping") {
      return res.status(200).json({ texto: "pong" });
    }

    // 2) API Key
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Falta OPENAI_API_KEY en Vercel" });
    }
    const MODEL = process.env.OPENAI_MODEL || DEFAULT_MODEL;

    // 3) Arma fuentes
    let srcs = req.query.src || req.body?.src || DEFAULT_SOURCES;
    if (!Array.isArray(srcs)) srcs = [srcs];
    // normaliza y filtra blocklist
    srcs = srcs
      .map(s => String(s || "").replace(/^\/+/, "")) // quita / inicial
      .filter(s => s && !BLOCKLIST.has(s));

    // 4) Lee fuentes
    const publicBase = getPublicBase(req);
    let corpus = "";
    for (const s of srcs) {
      try {
        const t = await readSource(publicBase, s);
        corpus += `\n\n===== Fuente: ${s} =====\n${t}\n`;
      } catch (e) {
        corpus += `\n\n===== Fuente: ${s} =====\n(No se pudo leer: ${e.message})\n`;
      }
    }

    // 5) Sesión y contexto
    // Si no pasas un sessionId explícito, por simplicidad usamos la IP+UA
    // (el front podría enviar un sessionId más estable si lo deseas).
    const sid =
      req.query.sessionId ||
      req.body?.sessionId ||
      `${req.headers["x-forwarded-for"] || req.socket.remoteAddress}::${req.headers["user-agent"] || ""}`;
    const session = getSession(String(sid));

    // 6) Mensaje del sistema (reglas que pediste)
    const system = [
      "Eres una asesora educativa clara y ejecutiva en español México.",
      "Debes devolver cálculos y análisis estadísticos COMPLETOS (medias, varianzas, correlaciones, regresiones simples si aplica).",
      "Formato de salida: primero texto (sin asteriscos), luego si hay tablas pidieron, produce tabla en CSV.",
      "Si piden orden/criterio, cumple estrictamente.",
      "Nunca digas 'no puedo'. Si falta info exacta, razona con lo disponible y ofrece alternativas.",
      "No menciones 'según el CSV...' explícitamente; responde directo.",
      "Ignora asteriscos (*) en cualquier texto.",
      "No repitas información textual que también devuelvas en tablas.",
      "Si piden lista/listado/tabla de estudiantes, devuelve columnas con títulos claros y numeración cuando corresponda.",
      `Fuentes disponibles:\n${srcs.map(s => " - " + s).join("\n")}`
    ].join("\n");

    // 7) Construye mensajes
    const messages = [
      { role: "system", content: system },
      // Contexto previo
      ...session.turns.slice(-MAX_TURNS_IN_CONTEXT),
      // Prompt actual con el corpus al final
      {
        role: "user",
        content: `Pregunta/Acción: ${qRaw}\n\nContexto de datos:\n${corpus}`
      }
    ];

    // 8) Llamada a OpenAI
    const raw = await callOpenAI(OPENAI_API_KEY, MODEL, messages);
    const text = sanitizeOutput(raw);

    // 9) Guarda turno
    pushTurn(session, "user", qRaw);
    pushTurn(session, "assistant", text);

    return res.status(200).json({
      texto: text,
      fuentes: srcs,
      formato: "texto"
    });

  } catch (err) {
    console.error("[ask] Error:", err);
    return res.status(500).json({ error: String(err && err.stack || err) });
  }
};
