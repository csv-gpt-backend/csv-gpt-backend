export default async function handler(req, res) {
  try {
    const q = (req.query?.q || req.body?.q || "").toString().trim() || "ping";

    // Busca la API key (nombre estándar y también tus variantes en español)
    const apiKey =
      process.env.OPENAI_API_KEY ||
      process.env.CLAVE_API_DE_OPENAI ||
      process.env["CLAVE API DE OPENAI"];

    if (!apiKey) {
      return res
        .status(500)
        .json({ error: "Falta la variable de entorno OPENAI_API_KEY." });
    }

    // Llamada simple al endpoint de Chat Completions
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // puedes cambiar por el modelo que uses
        messages: [
          {
            role: "system",
            content:
              "Eres una asistente educativa amable. Responde en español (México).",
          },
          { role: "user", content: q },
        ],
        temperature: 0.7,
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      return res
        .status(r.status)
        .json({ error: "OpenAI error", details: errText });
    }

    const data = await r.json();
    const text =
      data?.choices?.[0]?.message?.content?.trim() ||
      "No se obtuvo contenido.";

    return res.status(200).json({ text });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error interno", details: String(e) });
  }
}
