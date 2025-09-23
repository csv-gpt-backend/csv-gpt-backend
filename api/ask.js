// Temporalmente desactivado para pruebas.
// El endpoint principal ahora es /api/ask2.

export default function handler(req, res) {
  return res.status(200).json({
    ok: true,
    message: "ask.js desactivado temporalmente. Usa /api/ask2 para pruebas."
  });
}
