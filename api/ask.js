// api/ask.js
// Backend principal para procesar preguntas usando GPT-5
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

// Configuración de claves y archivos
const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-5";
const CSV_URL = "https://csv-gpt-backend.vercel.app/datos/decimo.csv";
const TXT_URL = "https://csv-gpt-backend.vercel.app/emocionales.txt";

const client = new OpenAI({ apiKey: OPENAI_KEY });

// Utilidad: leer CSV remoto
async function fetchFile(url) {
  try {
    const res = await fetch(url);
    return await res.text();
  } catch (err) {
    console.error("Error al leer archivo remoto:", err.message);
    return "";
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Método no permitido. Usa POST con JSON." });
    }

    if (!OPENAI_KEY) {
      return res.status(500).json({ error: "Falta la clave de OpenAI. Configúrala en Vercel." });
    }

    const { question } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Pregunta no válida." });
    }

    // Leer CSV y TXT
    const csvData = await fetchFile(CSV_URL);
    const txtData = await fetchFile(TXT_URL);

    // Armar prompt
    const systemPrompt = `
Eres una analista educativa rigurosa. Responde SIEMPRE en español neutro.

Reglas:
- Usa la información provista en el CSV y TXT para responder.
- Si el usuario pide tablas, responde en Markdown con columnas separadas por |.
- Nunca inventes datos.
- Si falta información, indícalo claramente.
- Devuelve SIEMPRE un JSON con:
  {
    "texto": "respuesta clara en español",
    "tablas_markdown": "si hay tabla, aquí; si no, vacío"
  }
`;

    const userPrompt = `
PREGUNTA: ${question}

DATOS CSV (fragmento inicial):
"""${csvData.slice(0, 10000)}"""

DATOS TXT (fragmento inicial):
"""${txtData.slice(0, 5000)}"""

Devuelve SOLO un JSON válido.
`;

    console.log("[ASK][PROMPT]", question);

    // Llamar a GPT-5
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 1,
      max_completion_tokens: 1000
    });

    const raw = completion?.choices?.[0]?.message?.content || "";
    console.log("[ASK][RAW]", raw);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn("[ASK][WARN] No se pudo parsear JSON. Enviando texto crudo.");
      parsed = { texto: raw, tablas_markdown: "" };
    }

    return res.status(200).json({
      texto: parsed.texto || "",
      tablas_markdown: parsed.tablas_markdown || ""
    });

  } catch (err) {
    console.error("[ASK][ERROR]", err.message);
    return res.status(500).json({
      texto: `Error en el servidor: ${err.message}`,
      tablas_markdown: ""
    });
  }
}
