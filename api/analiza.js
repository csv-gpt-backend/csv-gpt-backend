// api/analiza_ci.js — Enviar CSV al modelo y que GPT (Code Interpreter) lo analice y responda
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // en Vercel pon gpt-5
const CSV_CANDIDATES = [
  path.join(process.cwd(), "public", "datos.csv"),
  path.join(process.cwd(), "datos.csv"),
];

// Busca el CSV en el deploy
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
    if (!q) {
      res.status(400).json({ ok:false, error:"Falta el parámetro q" });
      return;
    }

    // 1) Localiza y sube el CSV a OpenAI Files (purpose assistants/tools)
    const csvPath = await findCsvPath();
    const fileStream = fs.createReadStream(csvPath);
    const uploaded = await client.files.create({
      file: fileStream,
      purpose: "assistants",
    });

    // 2) Llama a Responses con Code Interpreter y adjunta el CSV
    const system = `
Eres un analista educativo. 
Usa ÚNICAMENTE el archivo CSV adjunto para responder en español (claro y conciso).
Carga el CSV con Python y calcula lo que necesites. No inventes datos ni columnas.`;

    const user = `
Pregunta del usuario: ${q}

Instrucciones:
- Carga el CSV adjunto (usa pandas).
- Realiza los cálculos necesarios (medias, percentiles, comparaciones, etc.).
- No uses internet ni otros datos.
- Devuelve una respuesta en lenguaje natural (6–8 líneas), citando los valores clave.`;

    const response = await client.responses.create({
      model: MODEL,
      tools: [{ type: "code_interpreter" }],
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: user,
          // Adjuntamos el CSV y autorizamos su uso por Code Interpreter
          attachments: [
            { file_id: uploaded.id, tools: [{ type: "code_interpreter" }] }
          ],
        },
      ],
    });

    const text = response.output_text || "(sin texto)";
    res.status(200).json({ ok:true, respuesta: text });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || "Error interno" });
  }
}
