// api/ask.js — CommonJS (sin 'export', sin 'import')

exports.config = { runtime: 'nodejs18.x' };

module.exports = async (req, res) => {
  try {
    // Para ver rápidamente si la función está viva
    const q = (req.query.q || '').toString().trim().toLowerCase();
    if (q === 'ping') {
      return res.status(200).json({ text: 'pong' });
    }

    // Comprueba que la API Key existe
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Falta OPENAI_API_KEY en Vercel > Settings > Environment Variables' });
    }

    // Respuesta de prueba (luego aquí pondremos la lógica real)
    return res.status(200).json({ text: 'Función OK y variable OPENAI_API_KEY presente.' });
  } catch (err) {
    console.error('[ask] Error:', err);
    res.status(500).json({ error: String(err && err.stack || err) });
  }
};
