export default function handler(req, res) {
  res.setHeader('content-type', 'application/json');
  res.status(200).end(JSON.stringify({ ok: true, runtime: 'node', node: process.version }));
}
