// api/health.js g
const startedAt = Date.now();

export default function handler(req, res) {
  res.status(200).json({
    status: "ok",
    time: new Date().toISOString(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    service: "csv-gpt-backend",
    version: "1.0.0"
  });
}
