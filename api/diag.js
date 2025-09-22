export default function handler(req, res) {
  const keys = Object.keys(process.env || {}).filter(k => /open|model|node/i.test(k)).sort();
  res.setHeader('content-type', 'application/json');
  res.status(200).end(JSON.stringify({
    cwd: process.cwd(),
    node: process.version,
    envKeys: keys,                              // nombres visibles (no valores)
    hasApiKey: !!process.env.open_ai_key || !!process.env.OPENAI_API_KEY
  }));
}
