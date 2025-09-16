// api/ask.js — CSV -> GPT-5 (Code Interpreter) para análisis completo, respuesta en español.
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-5"; // pon el ID real que tengas habilitado
const CSV_CANDIDATES = [
  path.join(process.cwd(), "public", "datos.csv"),
  path.join(process.cwd(), "datos.csv"),
];

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Localiza el CSV en el deploy
async function findCsvPath() {
  for (const p of CSV_CANDIDATES) {
    try { await fsp.access(p); return p; } catch {}
  }
  return null;
}

// Sube el CSV a Files si no hay OPENAI_FILE_ID
async function getOrUploadFileId() {
  if (process.env.OPENAI_FILE_ID) return process.env.OPENAI_FILE_ID;

  const csvPath = await findCsvPath();
  if (!csvPath) {
    throw new Error("No encontré public/datos.csv ni ./datos.csv en el deploy y no hay OPENAI_FILE_ID.");
  }
  const uploaded = await client.files.create({
    file: fs.createReadStream(csvPath),
    purpose: "assistants",
  });
  return uploaded.id;
}

export default async function handler(req, res) {
  // CORS para Wix
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  try {
    if (!process.env.OPENAI_API_KEY) {
      res.status(400).json({ ok:false, error:"Falta OPENAI_API_KEY" });
      return;
    }

    // Salud/diagnóstico opcional
    if ((req.query?.q || "").toString().trim().toLowerCase() === "ping") {
      res.status(200).json({ ok:true, respuesta:"pong" });
      return;
    }

    const q = (req.query?.q || req.body?.q || "").toString().trim();
    if (!q) { res.status(400).json({ ok:false, error:"Falta el parámetro q" }); return; }

    // 1) Conseguir file_id del CSV (o subirlo)
    const fileId = await getOrUploadFileId();

    // 2) Prompt (cadena única para evitar ambigüedades)
    const system = `Eres un analista educativo. Usa ÚNICAMENTE el CSV adjunto.
Carga el CSV con Python (pandas) y realiza los cálculos necesarios.
Responde en español (6–8 líneas), claro y conciso. No inventes datos ni columnas.`;

    const user = `Pregunta: ${q}

Instrucciones:
- Carga el CSV adjunto (usa pandas).
- Haz los cálculos necesarios (medias, percentiles, comparaciones por alumno/dimensión).
- Redacta la respuesta en lenguaje natural citando valores clave.`;

    // 3) Responses + Code Interpreter + ATTACHMENTS EN RAÍZ
    const resp = await client.responses.create({
      model: MODEL,
      tools: [{ type: "code_interpreter" }],
      attachments: [{ file_id: fileId, tools: [{ type: "code_interpreter" }] }],
      input: `SYSTEM:\n${system}\n\nUSER:\n${user}`
    });

    res.status(200).json({ ok:true, respuesta: resp.output_text || "(sin texto)" });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || "Error interno" });
  }
}
