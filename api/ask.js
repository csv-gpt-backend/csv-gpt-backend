import fs from "fs";
import path from "path";
import Papa from "papaparse";
import OpenAI from "openai";

export const config = {
  runtime: "nodejs"
};

// Ruta al CSV dentro de /datos
const csvFilePath = path.join(process.cwd(), "datos", "decimo.csv");

// Inicializar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido. Usa POST con JSON." });
  }

  try {
    const { q } = req.body;

    if (!q || typeof q !== "string") {
      return res.status(400).json({ error: "Falta la pregunta (q) en el cuerpo de la solicitud." });
    }

    // Verificar si existe el archivo CSV
    if (!fs.existsSync(csvFilePath)) {
      return res.status(500).json({
        error: `No se encontró el archivo CSV en la ruta: ${csvFilePath}`
      });
    }

    // Leer CSV
    const csvData = fs.readFileSync(csvFilePath, "utf8");

    // Parsear CSV
    const parsed = Papa.parse(csvData, {
      header: true,
      skipEmptyLines: true
    });

    const rows = parsed.data;

    // Crear contexto con los datos del CSV
    const context = JSON.stringify(rows.slice(0, 20), null, 2);

    // Enviar a OpenAI
    const prompt = `
      Contexto con datos del CSV:
      ${context}

      Pregunta del usuario:
      ${q}

      Por favor responde de forma clara, en español y si corresponde incluye los datos en forma de tabla Markdown.
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "Eres un asistente que responde en español y genera respuestas claras." },
        { role: "user", content: prompt }
      ]
    });

    const respuesta = completion.choices[0].message.content.trim();

    return res.status(200).json({
      respuesta,
      dataPreview: rows.slice(0, 5)
    });

  } catch (error) {
    console.error("Error en /api/ask:", error);

    return res.status(500).json({
      error: "Error interno en el servidor.",
      detalles: error.message
    });
  }
}
