export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  res.status(200).json({ ok: true, now: new Date().toISOString() });
}
