// api/ask.js — GPT-5 con Code Interpreter y archivo CSV usando Assistants v2.
// Corrige el 400 "Unknown parameter: tool_resources" de Responses.
// Incluye CORS siempre, y endpoints ping/diag/dryrun para depurar.

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-5"; // ajusta si tu cuenta usa otro ID

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

// Esperar a que el run termine
async function waitForRunCompletion(threadId, runId, timeoutMs = 120000, intervalMs = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await client.beta.threads.runs.retrieve(threadId, runId);
    if (run.status === "completed") return run;
    if (run.status === "failed" || run.status === "expired" || run.status === "cancelled") {
      throw new Error(`Run ${run.status}: ${run.last_error?.message || "sin detalles"}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("Timeout esperando a que el run complete.");
}

// Extraer texto de los mensajes del thread (último del asistente)
function extractAssistantText(messagesList) {
  for (const m of messagesList.data) {
    if (m.role === "assistant") {
      let out = "";
      for (const p of m.content) {
        if (p.type === "text") out += p.text.value + "\n";
      }
      if (out.trim()) return out.trim();
    }
  }
  return "(sin texto)";
}

export default async function handler(req, res) {
  try { setCors(res); } catch {}

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
        sdkVersion: OpenAI.VERSION,
        node: process.version
      });
      return;
    }

    const { fileId } = await getOrUploadFileId();

    // Dryrun: contar filas con pandas y responder "filas = N"
    if (qRaw.toLowerCase() === "dryrun") {
      const thread = await client.beta.threads.create({
        messages: [{
          role: "user",
          content:
`Carga el CSV adjunto con pandas y responde EXACTAMENTE "filas = N" (sin más texto).`,
        }],
      });

      const run = await client.beta.threads.runs.create(thread.id, {
        model: MODEL,
        instructions: "Eres un analista. Usa Code Interpreter.",
        tools: [{ type: "code_interpreter" }],
        tool_resources: { code_interpreter: { file_ids: [fileId] } },
      });

      await waitForRunCompletion(thread.id, run.id);
      const messages = await client.beta.threads.messages.list(thread.id, { limit: 10 });
      const text = extractAssistantText(messages);
      res.status(200).json({ ok:true, respuesta: text });
      return;
    }

    // Pregunta real
    if (!qRaw) {
      res.status(400).json({ ok:false, error:"Falta el parámetro q" });
      return;
    }

    const system =
`Eres un analista educativo. Usa EXCLUSIVAMENTE el CSV adjunto.
Car
