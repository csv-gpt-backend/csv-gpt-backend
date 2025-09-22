// /api/ask.js (versión de diagnóstico)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
    return;
  }

  // Asegurar parsing tanto si Vercel entrega string como objeto
  let body = {};
  try {
    if (typeof req.body === 'string') {
      body = JSON.parse(req.body || '{}');
    } else {
      body = req.body || {};
    }
  } catch (e) {
    res.status(400).json({ error: 'JSON inválido' });
    return;
  }

  const question = String(body.question || '').trim();
  res.status(200).json({
    texto: question ? `Recibí tu pregunta: ${question}` : 'Pregunta vacía',
    tablas_markdown: ''
  });
}
