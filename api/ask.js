// Modelo por defecto: usa uno soportado por Assistants
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

// ... en la autocreación del assistant:
assistant = await client.beta.assistants.create({
  name: "CSV Analyst",
  model: MODEL,
  tools: [{ type: "code_interpreter" }], // deja activo el intérprete
  instructions:
    "Eres un analista de datos. Responde en español, claro y conciso (6–8 líneas).",
});
