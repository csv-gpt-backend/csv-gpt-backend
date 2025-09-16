// api/ask.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- CONFIG ---
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1"; // modelo soportado por Assistants
const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || ""; // si no lo pones, creamos uno temporal

// CORS — para que Wix pueda llamar al endpoint sin “Failed to fetch”
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // si quieres, cámbialo por tu dominio Wix
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(res, extra = {}) {
  Object.entries({ ...CORS_HEADERS, ...extra }).forEach(([k, v]) =>
    res.setHeader(k, v)
  );
}

function sendJSON(res, status, data) {
  withCors(res, { "Cache-Control": "no-store" });
  res.status(status).json(data);
}

export default async function handler(req, res) {
  try {
    // Manejo del preflight
    if (req.method === "OPTIONS") {
      withCors(res);
      return res.status(204).end();
    }

    // Permite GET (q como query) y POST (q en body)
    let q = "";
    if (req.method === "GET") {
      q = (req.query.q || "").toString();
    } else if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      q = (body.q || "").toString();
    } else {
      return sendJSON(res, 405, { ok: false, error: "Method Not Allowed" });
    }

    // Ping / Diagnóstico rápido
    if (!q || q.toLowerCase() === "ping") {
      return sendJSON(res, 200, { ok: true, respuesta: "pong" });
    }
    if (q.toLowerCase() === "diag") {
      return sendJSON(res, 200, {
        ok: true,
        env: {
          hasKey: !!process.env.OPENAI_API_KEY,
          model: MODEL,
          assistantIdFromEnv: !!ASSISTANT_ID,
        },
      });
    }

    // ---- LÓGICA: usamos Assistants v2 + Code Interpreter ----
    // Si te resulta más cómodo, puedes omitir Assistant y usar Responses directamente;
    // pero aquí lo dejamos listo para Attachments/Code Interpreter.
    let assistantId = ASSISTANT_ID;

    if (!assistantId) {
      // Creamos uno efímero con modelo válido
      const assistant = await client.beta.assistants.create({
        name: "CSV Analyst",
        model: MODEL,
        tools: [{ type: "code_interpreter" }], // para que pueda razonar con archivos si luego adjuntas
        instructions:
          "Responde en español de forma clara y concisa (6-8 líneas). Razona sobre datos cuando tengas CSV adjunto.",
      });
      assistantId = assistant.id;
    }

    // Creamos thread y run
    const thread = await client.beta.threads.create({
      messages: [
        {
          role: "user",
          content: q,
        },
      ],
    });

    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
    });

    // Polling simple hasta que termine
    let status = run.status;
    let tries = 0;
    while (status === "queued" || status === "in_progress") {
      await new Promise((r) => setTimeout(r, 1000));
      const r2 = await client.beta.threads.runs.retrieve(thread.id, run.id);
      status = r2.status;
      tries += 1;
      if (tries > 60) break; // ~60s
    }

    if (status !== "completed") {
      return sendJSON(res, 500, {
        ok: false,
        error: `Run not completed: ${status}`,
      });
    }

    const m = await client.beta.threads.messages.list(thread.id, { limit: 1 });
    const latest = m.data?.[0];
    let text = "";
    if (latest?.content?.length) {
      for (const c of latest.content) {
        if (c.type === "text" && c.text?.value) {
          text += c.text.value + "\n";
        }
      }
    }
    if (!text) text = "(Sin texto de salida)";

    return sendJSON(res, 200, { ok: true, respuesta: text.trim() });
  } catch (e) {
    // Devuelve el mensaje real; en Wix verás el error exacto en vez de “Failed to fetch”
    return sendJSON(res, 500, {
      ok: false,
      error: e?.response?.data ?? e?.message ?? "Error inesperado",
    });
  }
}
