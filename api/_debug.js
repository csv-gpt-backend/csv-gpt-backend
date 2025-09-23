// /api/_debug.js
import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  try {
    const dir = path.join(process.cwd(), 'api');
    const files = fs.readdirSync(dir).sort();
    res.status(200).json({ ok: true, api_files: files });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e) });
  }
}
