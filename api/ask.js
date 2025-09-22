// /api/ask.js  (OpenAI mínimo, sin CSV/PDF)
import OpenAI from 'openai';
const client = new OpenAI({ apiKey: process.env.open_ai_key });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });

    let body = {};
    try { body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{}); }
    catch { return res.status(400).json({ error: 'JSON inválido' }); }

    const q = String(body.question || '').replace(/\*/g,'').trim();
    if (!q) return res.status(200).json({ texto: 'Escribe una pregunta.', tablas_markdown: '' });

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Responde en español (MX/EC). Devuelve SOLO JSON: {"texto":string,"tablas_markdown":string}' },
        { role: 'user', content: `Pregunta: ${q}\nDevuelve el JSON pedido.` }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || '{}';
    let out; try { out = JSON.parse(raw); } catch { out = { texto: raw, tablas_markdown: '' }; }
    return res.status(200).json({
      texto: String(out.texto || out.text || '').replace(/\*/g,''),
      tablas_markdown: String(out.tablas_markdown || '').replace(/\*/g,'')
    });
  } catch (err) {
    const msg = (err?.response?.data?.error?.message) || err?.message || 'desconocido';
    return res.status(200).json({ texto: 'Error backend: ' + msg, tablas_markdown: '' });
  }
}
