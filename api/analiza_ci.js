// api/analiza_ci.js — CSV -> GPT (Code Interpreter) para análisis completo
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // En Vercel usa gpt-5
const CSV_CANDIDATES = [
  path.join(process.cwd(), "public", "datos.csv"),
  path.join(process.cwd(), "datos.csv"),
];

async function findCsvPath() {
  for (const p of CSV_CANDIDATES) {
    try { await fsp.access(p); return p; } catch {}
  }
  throw new Error("No encontré public/datos.csv ni ./datos.csv");
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  try {
    if (!process.env.OPENAI_API_KEY) {
      res.status(400).json({ ok:false, error:"Falta OPENAI_API_KEY" });
      return;
    }

    const q = (req.query?.q || req.body?.q || "").toString().trim();
    if (!q) { res.status(400).json({ ok:false, error:"Falta el parámetro q" }); return; }

    // 1) Subir CSV a OpenAI Files
    const csvPath = await findCsvPath();
    const uploaded = await client.files.create({
      file: fs.createReadStream(csvPath),
      purpose: "assistants",
    });

    // 2) Prompt
    const system = `
Eres un analista educativo. Usa ÚNICAMENTE el CSV adjunto.
Carga el CSV con Python (pandas) y realiza los cálculos necesarios.
Responde en español, claro y conciso (6–8 líneas). No inventes columnas ni datos.`;

    const userText = `
Pregunta del usuario: ${q}

Instrucciones:
- Carga el CSV adjunto.
- Calcula lo necesario (medias, percentiles, comparaciones por alumno/dimensión).
- Redacta la respuesta con los valores clave.`;

    // 3) Responses API con Code Interpreter y ATTACHMENTS EN RAÍZ
    const resp = await client.responses.create({
      model: MODEL,
      tools: [{ type: "code_interpreter" }],
      attachments: [
        { file_id: uploaded.id, tools: [{ type: "code_interpreter" }] }
      ],
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user",   content: [{ type: "input_text", text: userText }] },
      ],
    });

    res.status(200).json({ ok:true, respuesta: resp.output_text || "(sin texto)" });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || "Error interno" });
  }
}
