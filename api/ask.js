// api/ask.js
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ====== CONFIG ======
const OPENAI_API_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CSV_FILE       = process.env.CSV_FILE || 'datos/decimo.csv';

// cliente OpenAI
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Normaliza texto para “match” de columnas (sin acentos, minúsculas)
const norm = s => (s??'').toString()
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/\s+/g,' ').trim().toLowerCase();

// Mapa de columnas esperadas (18 columnas; añade alias comunes)
const COLMAP = {
  nombre: ['nombre','estudiante','alumno'],
  promedio_hab_interpersonales: [
    'promedio de habilidades interpersonales','promedio habilidades interpersonales','interpersonales'
  ],
  motivacion: ['motivación','motivacion'],
  compromiso: ['compromiso'],
  administracion_tiempo: ['administración del tiempo','administracion del tiempo','tiempo'],
  toma_decisiones: ['toma de decisiones','decisiones'],
  liderazgo: ['liderazgo'],
  promedio_hab_vida: ['promedio de habilidades para la vida','habilidades para la vida','vida'],
  promedio_inteligencia_emocional: ['promedio de inteligencia emocional','inteligencia emocional','emocional'],
  agresion: ['agresión','agresion'],
  timidez: ['timidez'],
  propension_cambio: ['propensión al cambio','propension al cambio','cambio'],
  empatia: ['empatía','empatia'],
  asertividad: ['asertividad'],
  manejo_estres: ['manejo de estrés','manejo de estres','estres','estrés'],
  resiliencia: ['resiliencia'],
  autocontrol: ['autocontrol'],
  comunicacion: ['comunicación','comunicacion']
};

// convierte encabezados del CSV a claves internas usando COLMAP
function mapHeaders(csvHeaders){
  const mapped = {};
  csvHeaders.forEach((h,idx)=>{
    const H = norm(h);
    for(const key of Object.keys(COLMAP)){
      const aliases = COLMAP[key].map(norm);
      if(aliases.some(a => H.includes(a))){
        mapped[key] = idx;
        return;
      }
    }
    // Fallbacks muy comunes
    if(!mapped.nombre && /nombre/i.test(h)) mapped.nombre = idx;
  });
  return mapped;
}

// crea tabla (headers & rows) según columnas pedidas
function buildTable(dataRows, headerMap, requestedKeys=null){
  // si no especificas columnas, usa todas las disponibles ordenadas por COLMAP:
  const allOrder = Object.keys(COLMAP);
  const keys = (requestedKeys && requestedKeys.length)
    ? requestedKeys.filter(k => headerMap[k]!=null && headerMap[k]!==undefined)
    : allOrder.filter(k => headerMap[k]!=null && headerMap[k]!==undefined);

  const headers = keys.map(k => {
    // “bonito” para título
    return Object.values(COLMAP).includes(COLMAP[k])
      ? COLMAP[k][0].replace(/\b\w/g, c=>c.toUpperCase())
      : k;
  });

  const rows = dataRows.map(r => keys.map(k => r[headerMap[k]] ?? ''));

  return { headers, rows };
}

// detecta qué columnas quiere el usuario
function detectRequestedColumns(question){
  const q = norm(question);
  const wanted = [];

  // si piden “todos los estudiantes” o “todas las columnas”
  if(/todos? los estudiantes|todas? las columnas|todos los datos|muestrame todo|lista completa/.test(q)){
    return []; // significa “todas”
  }

  for(const key of Object.keys(COLMAP)){
    const aliases = COLMAP[key].map(norm);
    if(aliases.some(a => q.includes(a))) wanted.push(key);
  }

  // si pidieron “nombre” implícito cuando pides alguna habilidad
  if(!wanted.includes('nombre') && wanted.length) wanted.unshift('nombre');

  return wanted;
}

// ====== HANDLER ======
export default async function handler(req, res){
  if(req.method!=='POST'){
    res.setHeader('Content-Type','application/json');
    return res.status(200).json({ error:'Método no permitido. Usa POST con JSON.' });
  }
  if(!OPENAI_API_KEY){
    return res.status(200).json({ texto:'Falta la open_ai_key en Vercel.' });
  }

  try{
    const { question='' } = req.body || {};
    const csvPath = path.join(__dirname, '..', CSV_FILE);
    const csvRaw  = fs.readFileSync(csvPath, 'utf8');
    const parsed  = Papa.parse(csvRaw, { header:true, skipEmptyLines:true });

    // Arreglo de filas crudas (array de valores) y encabezados originales
    const csvHeaders = parsed.meta.fields || Object.keys(parsed.data[0]||{});
    const headerMap  = mapHeaders(csvHeaders);
    const matrix     = parsed.data.map(row => csvHeaders.map(h => (row[h]??'').toString().trim()));

    // detección de columnas pedidas
    const requested = detectRequestedColumns(question);

    // tabla final
    const tabla = buildTable(matrix, headerMap, requested);

    // Texto con OpenAI (pregunta contextual, explica y/o resume)
    const sys = `Eres una asistente pedagógica. Responde en español (es-MX). 
Hablas breve y claro. Si el usuario pide listas/columnas, se le mostrará una tabla aparte; 
tu texto debe ser una explicación corta.`;
    const user = `Pregunta del usuario: """${question}"""
Hay ${tabla.rows.length} filas en la tabla resultante y ${tabla.headers.length} columnas: ${tabla.headers.join(', ')}. 
Explica brevemente qué se está mostrando y, si procede, cómo interpretar.`;

    let texto = 'No obtuve respuesta.';
    try{
      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          { role:'system', content: sys },
          { role:'user',   content: user }
        ],
        temperature: 0.3,
      });
      texto = completion.choices?.[0]?.message?.content?.trim() || texto;
    }catch(e){
      // si falla OpenAI, al menos entrega tabla
      texto = 'Aquí tienes la tabla solicitada.';
    }

    res.setHeader('Content-Type','application/json');
    return res.status(200).json({
      texto,
      tabla
    });

  }catch(err){
    console.error('ASK ERROR:', err);
    return res.status(200).json({
      texto: `ERROR DETECTADO: ${err?.message || JSON.stringify(err)}`,
      tabla: { headers:[], rows:[] }
    });
  }
}
