// 3) Responses API con Code Interpreter y archivo adjunto vía tool_resources
const resp = await client.responses.create({
  model: MODEL,
  tools: [{ type: "code_interpreter" }],
  // Asignamos el CSV al Code Interpreter aquí (en vez de 'attachments'):
  tool_resources: { code_interpreter: { file_ids: [fileId] } },

  // Puedes usar una sola cadena como input:
  input: `SYSTEM:
${system}

USER:
${user}`
});

// Entregamos el texto
res.status(200).json({ ok: true, respuesta: resp.output_text || "(sin texto)" });
