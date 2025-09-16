// api/ask.js — Assistants v2 con Code Interpreter (dos pasos: start / poll)
// Compatible con Vercel Hobby (timeout 10s). Incluye CORS, ping, diag.
// Si tienes el CSV local en public/datos.csv lo sube; o usa OPENAI_FILE_ID si lo defines.

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

async function createThreadRun({ question, fileId }) {
  const system =
`Eres un analista educativo. Usa EXCLUSIVAMENTE el CSV adjunto.
Carga el CSV con Python (pandas) y realiza los cálculos necesarios.
Responde en español, claro y conciso (6–8 líneas). No inventes columnas ni datos.`;

  const user =
`Pregunta: ${question}

Instrucciones:
- Carga el CSV adjunto con pandas.
- Calcula medias, percentiles y comparaciones por alumno/dimensión cuando aplique.
- Redacta en lenguaje natural citando algunos valores clave.`;

  const thread = await client.beta.threads.create({
    messages: [{ role: "user", content: `SYSTEM:\n${system}\n\nUSER:\n${user}` }],
  });

  const run = await client.beta.threads.runs.create(thread.id, {
    model: MODEL,
    instructions: "Analiza el CSV usando Code Interpreter.",
    tools: [{ type: "code_interpreter" }],
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
  return { done: false }; // sigue procesando
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
        csvCandidates: CSV_CANDIDATES,
        csvFound: !!csvPath,
        csvPath,
        sdkVersion: OpenAI.VERSION,
        node: process.version
      });
      return;
    }

    const { fileId } = await getOrUploadFileId();

    // ---------- start: crea y devuelve thread/run en < 2s ----------
    if (mode === "start") {
      if (!qParam) { res.status(400).json({ ok:false, error:"Falta el parámetro q" }); return; }
      const { threadId, runId } = await createThreadRun({ question: qParam, fileId });
      res.status(200).json({ ok:true, processing:true, threadId, runId });
      return;
    }

    // ---------- poll: espera hasta ~8s y devuelve si está listo ----------
    if (mode === "poll") {
      const threadId = (req.query?.threadId || req.body?.threadId || "").toString();
      const runId    = (req.query?.runId    || req.body?.runId    || "").toString();
      if (!threadId || !runId) { res.status(400).json({ ok:false, error:"Falta threadId o runId" }); return; }

      const r = await pollRun(threadId, runId, 8000, 1200);
      if (r.done) res.status(200).json({ ok:true, processing:false, respuesta: r.text });
      else        res.status(200).json({ ok:true, processing:true });
      return;
    }

    // fallback
    res.status(400).json({ ok:false, error:"Modo inválido. Usa mode=start o mode=poll" });

  } catch (e) {
    try { setCors(res); } catch {}
    res.status(500).json({ ok:false, error: e?.message || "Error interno" });
  }
}
