// /api/ask.js  (ECO para probar flujo)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
  }
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{}); }
  catch { return res.status(400).json({ error: 'JSON inválido' }); }

  const q = String(body.question || '').trim();
  return res.status(200).json({
    texto: q ? `Recibí: ${q}` : 'Pregunta vacía',
    tablas_markdown: ''
  });
}
