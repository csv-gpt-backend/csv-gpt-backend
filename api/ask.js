// api/ask.js — Assistants v2 con Code Interpreter (start & poll) + creación automática de Assistant.
// Requiere: openai@latest y OPENAI_API_KEY en Vercel.

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
  const up = await client.files.create({
    file: fs.createReadStream(csvPath),
    purpose: "assistants",
  });
  return { fileId: up.id, source: "uploaded" };
}

// Obtiene un assistant_id desde env o crea uno nuevo (con Code Interpreter)
async function getAssistantId() {
  if (process.env.OPENAI_ASSISTANT_ID) {
    return { assistantId: process.env.OPENAI_ASSISTANT_ID, source: "env" };
  }
  const created = await client.beta.assistants.create({
    model: MODEL,
    name: "CSV Analyst (auto)",
    instructions:
      "Eres un analista educativo. Usa exclusivamente el CSV adjunto. " +
      "Carga el CSV con pandas y realiza cálculos/estadísticas solicitadas. " +
      "Responde en español, claro y conciso (6–8 líneas). No inventes columnas ni datos.",
    tools: [{ type: "code_interpreter" }],
  });
  return { assistantId: created.id, source: "created" };
}

async function createThreadRun({ question, fileId, assistantId }) {
  const userMessage =
`Pregunta: ${question}

Instrucciones:
- Carga el CSV adjunto con pandas.
- Calcula medias, percentiles, comparaciones por alumno/dimensión (si aplica).
- Redacta en lenguaje natural citando algunos valores clave.`;

  const thread = await client.beta.threads.create({
    messages: [{ role: "user", content: userMessage }],
  });

  // En v2 debes pasar assistant_id (NO 'model')
  const run = await client.beta.threads.runs.create(thread.id, {
    assistant_id: assistantId,
    tool_resources: { code_interpreter: { file_ids: [fileId] } },
  });

  return { threadId: thread.id, runId: run.id };
}

async function pollRun(threadId, runId, maxWaitMs = 8000, stepMs = 1200) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const run = await client.beta.threads.runs.retrieve(threadId, runId);
    if (run.status === "completed") {
      const msgs = await client.beta.threads.messages.list(threadId, { limit: 20 });
      const text = extractAssistantText(msgs) || "(sin texto)";
      return { done: true, text };
    }
    if (["failed", "expired", "cancelled"].includes(run.status)) {
      throw new Error(`Run ${run.status}: ${run.last_error?.message || "sin detalles"}`);
    }
    await new Promise(r => setTimeout(r, stepMs));
  }
  return { done: false };
}

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
  return "";
}

export default async function handler(req, res) {
  try { setCors(res); } catch {}
  if (req.method === "OPTIONS" || req.method === "HEAD") {
    res.status(200).end(); return;
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      res.status(400).json({ ok:false, error:"Falta OPENAI_API_KEY" }); return;
    }

    const qParam = (req.query?.q || req.body?.q || "").toString().trim();
    const mode  = (req.query?.mode || req.body?.mode || "start").toString();

    // Salud
    if (qParam.toLowerCase() === "ping") {
      res.status(200).json({ ok:true, respuesta:"pong" }); return;
    }

    // Diagnóstico
    if (qParam.toLowerCase() === "diag") {
      const csvPath = await findCsvPath();
      res.status(200).json({
        ok: true,
        model: MODEL,
        hasKey: !!process.env.OPENAI_API_KEY,
        fileIdFromEnv: !!process.env.OPENAI_FILE_ID,
        assistantIdFromEnv: !!process.env.OPENAI_ASSISTANT_ID,
        csvCandidates: CSV_CANDIDATES,
        csvFound: !!csvPath,
        csvPath,
        sdkVersion: OpenAI.VERSION,
        node: process.version
      });
      return;
    }

    const { assistantId } = await getAssistantId();          // <-- aquí resolvemos assistant_id
    const { fileId }      = await getOrUploadFileId();

    if (mode === "start") {
      if (!qParam) { res.status(400).json({ ok:false, error:"Falta el parámetro q" }); return; }
      const { threadId, runId } = await createThreadRun({ question: qParam, fileId, assistantId });
      res.status(200).json({ ok:true, processing:true, threadId, runId });
      return;
    }

    if (mode === "poll") {
      const threadId = (req.query?.threadId || req.body?.threadId || "").toString();
      const runId    = (req.query?.runId    || req.body?.runId    || "").toString();
      if (!threadId || !runId) { res.status(400).json({ ok:false, error:"Falta threadId o runId" }); return; }

      const r = await pollRun(threadId, runId, 8000, 1200);
      if (r.done) res.status(200).json({ ok:true, processing:false, respuesta: r.text });
      else        res.status(200).json({ ok:true, processing:true });
      return;
    }

    res.status(400).json({ ok:false, error:"Modo inválido. Usa mode=start o mode=poll" });

  } catch (e) {
    try { setCors(res); } catch {}
    res.status(500).json({ ok:false, error: e?.message || "Error interno" });
  }
}
