// api/ask.js

import fs from "fs/promises";
import path from "path";
import { parse as parseCsv } from "csv-parse/sync";
import OpenAI from "openai";

export const config = { runtime: "nodejs" };

// Soporta tu variable 'open_ai_key' (minúsculas) y también la estándar OPENAI_API_KEY
const API_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;

const openai = new OpenAI({
  apiKey: API_KEY
});

// Ruta al CSV dentro de /datos
const CSV_PATH = path.join(process.cwd(), "datos", "decimo.csv");

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Método no permitido. Usa POST con JSON." });
      return;
    }

    if (!API_KEY) {
      res.status(500).json({ error: "Falta la variable de entorno 'open_ai_key' (o 'OPENAI_API_KEY')." });
      return;
    }

    // Cuerpo
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const q = String(body.q || body.question || "").trim();

    if (!q) {
      res.status(400).json({ error: "Falta la pregunta (q / question) en el cuerpo de la solicitud." });
      return;
    }

    // Leer CSV
    let csvText = "";
    try {
      csvText = await fs.readFile(CSV_PATH, "utf8");
    } catch {
      res.status(500).json({ error: `No se encontró el archivo CSV en: ${CSV_PATH}` });
      return;
    }

    // Parsear CSV
    let rows = [];
    try {
      rows = parseCsv(csvText, { columns: true, skip_empty_lines: true });
    } catch (e) {
      // Reintento por si el separador fuera ;
      rows = parseCsv(csvText, { columns: true, skip_empty_lines: true, delimiter: ";" });
    }

    // Para no pasar todo el CSV si es muy grande, mandamos un preview
    const preview = rows.slice(0, 30);

    const prompt = `
Eres una analista que responde en español (voz femenina MX/EC). 
Responde de forma clara en español. Si corresponde, incluye tablas en Markdown.

Contexto (muestra de los datos CSV):
${JSON.stringify(preview, null, 2)}

Pregunta del usuario:
${q}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // puedes cambiarlo por gpt-5.1 si tu cuenta lo permite
      messages: [
        { role: "system", content: "Eres una analista que responde en español latino, clara y precisa. Usa tablas Markdown si aplica." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2
    });

    const respuesta = completion.choices?.[0]?.message?.content?.trim() || "No hubo respuesta del modelo.";

    res.status(200).json({
      respuesta,
      filas_previas: preview.length
    });
  } catch (error) {
    console.error("ASK ERROR:", error);
    res.status(500).json({ error: "Error interno.", detalle: String(error?.message || error) });
  }
}
