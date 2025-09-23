// /api/answer.js
// Analiza TXT (embebido), CSV (/datos/decimo.csv) y PDFs opcionales (/datos/pdfs/*.pdf)
// y llama a OpenAI con tu clave (env: open_ai_key u OPENAI_API_KEY).
import fs from "fs";
import path from "path";

export const config = { runtime: "nodejs" };

// ---------- Utilidades ----------
function clip(s, max = 80000) {
  s = String(s || "");
  return s.length > max ? s.slice(0, max) + `\n[... recortado ...]` : s;
}

function safeRead(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

async function readPDFsOrTxt() {
  const base = path.join(process.cwd(), "datos", "pdfs");
  try {
    if (!fs.existsSync(base)) return { text: "", files: [] };
    const files = fs.readdirSync(base).filter(f => f.toLowerCase().endsWith(".pdf"));
    if (files.length === 0) {
      // admite .txt de respaldo
      const txts = fs.readdirSync(base).filter(f => f.toLowerCase().endsWith(".txt"));
      const text = txts.map(f => safeRead(path.join(base, f))).join("\n\n");
      return { text, files: txts };
    }
    // Intento de extracción con pdf-parse (si está instalado)
    try {
      const pdfParse = (await import("pdf-parse")).default;
      const out = [];
      for (const f of files) {
        const buff = fs.readFileSync(path.join(base, f));
        const data = await pdfParse(buff).catch(() => null);
        if (data?.text) out.push(data.text);
      }
      return { text: out.join("\n\n"), files };
    } catch {
      // Si no hay dependencias, no rompemos: el usuario puede subir .txt extraídos
      return { text: "", files };
    }
  } catch {
    return { text: "", files: [] };
  }
}

// ---------- Carga de fuentes locales ----------
async function gatherLocalCorpus() {
  // 1) Texto embebido
  let textoBase = "";
  try {
    const mod = await import("../data/texto_base.js");
    textoBase = String(mod?.TEXTO_BASE ?? "");
  } catch {
    textoBase = "";
  }

  // 2) CSV
  const csvPath = path.join(process.cwd(), "datos", "decimo.csv");
  const csv = safeRead(csvPath);

  // 3) PDFs (o .txt en /datos/pdfs)
  const pdfs = await readPDFsOrTxt();

  return {
    textoBase: clip(textoBase, 120000),
    csv: clip(csv, 120000),
    pdfText: clip(pdfs.text, 180000),
    meta: { csvPath, pdfFiles: pdfs.files }
  };
}

// ---------- OpenAI ----------
async function callOpenAI({ question, corpus, model, apiKey }) {
  const { textoBase, csv, pdfText } = corpus;
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey });

  const system = `
Eres una analista experta. Responde en ESPAÑOL neutro (MX/EC), con precisión.
REGLAS:
- Ignora cualquier * (asteriscos) de la entrada.
- No digas "según el archivo CSV", ni "no puedo realizar".
- Puedes hacer cálculos psicométricos, promedios, regresiones simples, progresiones y estadística básica.
- Cuando el usuario pida listas o tablas, entrégalos como tablas estructuradas.
- Devuelve EXCLUSIVAMENTE JSON válido con esta forma:
{
  "general": "<texto con explicación y cálculo si aplica>",
  "tables": [
    {"title":"...","columns":["Col1","Col2",...],"rows":[["v1","v2"],["..."]]}
  ]
}
No incluyas triple backticks ni texto fuera del JSON.
`;

  const user = `
PREGUNTA: ${String(question || "").replaceAll("*","")}

FUENTES DISPONIBLES (puedes combinarlas):
[TXT embebido]
${textoBase ? textoBase : "(vacío)"}

[CSV decimo.csv]
${csv ? csv : "(vacío)"}

[PDF/TXT]
${pdfText ? pdfText : "(vacío)"}
`;

  const resp = await client.chat.completions.create({
    model: model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    response_format: { type: "json_object" }
  });

  const content = resp.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

// ---------- Handler ----------
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const body = req.method === "POST" ? (req.body || {}) : (req.query || {});
    const question = String(body.question || body.q || "");
    const model = String(body.model || "");
    const apiKey = process.env.open_ai_key || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "Falta la variable de entorno open_ai_key / OPENAI_API_KEY." });
    }

    const corpus = await gatherLocalCorpus();
    const answer = await callOpenAI({ question, corpus, model, apiKey });

    return res.status(200).json({
      ok: true,
      source: { hasTXT: !!corpus.textoBase, hasCSV: !!corpus.csv, hasPDF: !!corpus.pdfText, pdfFiles: corpus.meta.pdfFiles },
      answer
    });
  } catch (err) {
    console.error(err);
    return res.status(200).json({
      ok: false,
      error: String(err?.message || err)
    });
  }
}
