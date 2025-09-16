// api/ask.js — ÚNICO endpoint. GPT-5 + Code Interpreter con CSV.
// Robustecido: CORS siempre, GET/OPTIONS/HEAD, diag/dryrun para depurar.

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-5"; // cambia si tu cuenta usa otro ID
const CSV_CANDIDATES = [
  path.join(process.cwd(), "public", "datos.csv"),
  path.join(process.cwd(), "datos.csv"),
];

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
}

async function findCsvPath() {
  for (const p of CSV_CANDIDATES) {
    try { await fsp.access(p); return p; } catch {}
  }
  return null;
}

async function getOrUploadFileId() {
  if (process.env.OPENAI_FILE_ID) {
    return { fileId: process.env.OPENAI_FILE_ID, source: "env" };
  }
  const csvPath = await findCsvPath();
  if (!csvPath) {
    throw new Error("No encontré public/datos.csv ni ./datos.csv y no hay OPENAI_FILE_ID.");
  }
  const uploaded = await client.files.create({
    file: fs.createReadStream(csvPath),
    purpose: "assistants",
  });
  return { fileId: uploaded.id, source: "uploaded" };
}

export default async function handler(req, res) {
  // CORS SIEMPRE
  try { setCors(res); } catch {}

  // OPTIONS/HEAD
  if (req.method === "OPTIONS" || req.method === "HEAD") {
    res.status(200).end();
    return;
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      res.status(400).json({ ok:false, error:"Falta OPENAI_API_KEY" });
      return;
    }

    const qRaw = (req.query?.q || req.body?.q || "").toString().trim();

    // Salud
    if (qRaw.toLowerCase() === "ping") {
      res.status(200).json({ ok:true, respuesta:"pong" });
      return;
    }

    // Diagnóstico
    if (qRaw.toLowerCase() === "diag") {
      const csvPath = await findCsvPath();
      res.status(200).json({
        ok: true,
        model: MODEL,
        hasKey: !!process.env.OPENAI_API_KEY,
        fileIdFromEnv: !!process.env.OPENAI_FILE_ID,
        csvCandidates: CSV_CANDIDATES,
        csvFound: !!csvPath,
        csvPath,
        vercel: !!process.env.VERCEL,
        node: process.version
      });
      return;
    }

    // Dryrun: probar lectura del CSV con pandas
    if (qRaw.toLowerCase() === "dryrun") {
      const { fileId } = await getOrUploadFileId();
      const resp = await client.responses.create({
        model: MODEL,
        tools: [{ type: "code_interpreter" }],
        tool_resources: { code_interpreter: { file_ids: [fileId] } },
        input: `SYSTEM:
Eres un analista. Usa pandas para cargar el CSV adjunto.

USER:
Carga el CSV y responde SOLO: "filas = N" (sin más texto).`
      });
      res.status(200).json({ ok:true, respuesta: resp.output_text || "(sin texto)" });
      return;
    }

    // Pregunta real
    if (!qRaw) {
      res.status(400).json({ ok:false, error:"Falta el parámetro q" });
      return;
    }

    const { fileId } = await getOrUploadFileId();

    const system = `Eres un analista educativo. Usa ÚNICAMENTE el CSV adjunto.
Carga el CSV con Python (pandas) y realiza los cálculos necesarios.
Responde en español (6–8 líneas), claro y conciso. No inventes datos ni columnas.`;

    const user = `Pregunta: ${qRaw}

Instrucciones:
- Carga el CSV adjunto (usa pandas).
- Calcula medias, percentiles y comparaciones por alumno/dimensión cuando aplique.
- Redacta en lenguaje natural citando valores clave.`;

    const resp = await client.responses.create({
      model: MODEL,
      tools: [{ type: "code_interpreter" }],
      tool_resources: { code_interpreter: { file_ids: [fileId] } },
      input: `SYSTEM:\n${system}\n\nUSER:\n${user}`
    });

    res.status(200).json({ ok:true, respuesta: resp.output_text || "(sin texto)" });
  } catch (e) {
    // Si algo se rompe ANTES, esto asegura respuesta con CORS
    try { setCors(res); } catch {}
    res.status(500).json({ ok:false, error: e?.message || "Error interno" });
  }
}
