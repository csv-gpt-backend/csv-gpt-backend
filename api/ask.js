// api/ask.js  (Vercel Serverless - CommonJS)
const fs = require("fs").promises;
const path = require("path");

// ---------- CSV helpers ----------
function detectDelimiter(line){const c=[",",";","\t","|"];let b={d:",",n:0};for(const d of c){const n=line.split(d).length;if(n>b.n)b={d,n}}return b.d}
function splitCSVLine(line,d){const o=[];let c="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(q&&line[i+1]==='"'){c+='"';i++}else q=!q}else if(ch===d&&!q){o.push(c);c=""}else c+=ch}o.push(c);return o.map(s=>s.trim())}
function parseCSV(t){const L=t.replace(/\r/g,"").split("\n").filter(l=>l.length>0);if(!L.length)return{headers:[],rows:[],delimiter:","};const d=detectDelimiter(L[0]);const h=splitCSVLine(L[0],d);const r=[];for(let i=1;i<L.length;i++){const v=splitCSVLine(L[i],d);const o={};h.forEach((H,idx)=>o[H]=v[idx]??"");r.push(o)}return{headers:h,rows:r,delimiter:d}}
function toNum(v){if(v==null)return null;if(typeof v==="number")return isFinite(v)?v:null;let s=String(v).trim();if(s===""||s.toLowerCase()==="na"||s.toLowerCase()==="null")return null;let n=Number(s);if(Number.isNaN(n)&&s.includes(",")&&!s.includes("."))n=Number(s.replace(",", "."));return Number.isFinite(n)?n:null}
function firstNumericKey(o){if(!o)return null;for(const k of Object.keys(o))if(toNum(o[k])!==null)return k;return null}
const normalize=s=>String(s??"").normalize("NFD").replace(/\p{Diacritic}/gu,"").toUpperCase().trim();
function caseMap(h){const m={};h.forEach(x=>m[x.toLowerCase()]=x);return m}
function getCol(h,...aliases){const cm=caseMap(h);for(const a of aliases){const k=cm[a.toLowerCase()];if(k)return k}for(const H of h){const N=normalize(H);if(aliases.some(a=>N.includes(normalize(a))))return H}return null}

// ---------- Fallback FS→HTTP ----------
async function readCSVFromFsOrHttp(file, req){
  const p=path.join(process.cwd(),"public","datos",file);
  try{ return await fs.readFile(p,"utf8"); }
  catch{
    const host=req.headers["x-forwarded-host"]||req.headers.host||"localhost:3000";
    const proto=host.includes("localhost")?"http":"https";
    const url=`${proto}://${host}/datos/${encodeURIComponent(file)}`;
    const r=await fetch(url); if(!r.ok) throw new Error(`HTTP ${r.status} al leer ${url}`);
    return await r.text();
  }
}

// ---------- Handler ----------
module.exports = async (req, res) => {
  const q=String(req.query?.q||"");
  const file=String(req.query?.file||"decimo.csv");
  const format=String(req.query?.format||"json").toLowerCase();
  const limit=req.query?.limit;
  const columns=req.query?.columns;
  const sort_by=req.query?.sort_by;
  const filter_key=req.query?.filter_key;
  const filter_val=req.query?.filter_val;
  const DEBUG=String(req.query?.debug||"").toLowerCase()==="1"||String(req.query?.debug||"").toLowerCase()==="true";

  try{
    const raw=await readCSVFromFsOrHttp(file,req);
    const {headers,rows}=parseCSV(raw);

    // columnas típicas
    const colNombre   = getCol(headers,"Nombre","Estudiante","Alumno");
    const colParalelo = getCol(headers,"Paralelo","Sección","Seccion","Grupo");
    const colCurso    = getCol(headers,"Curso","Grado","Nivel");

    let data = rows.map(r=>({...r}));

    // ?columns=...
    if(columns){
      const cm=caseMap(headers);
      const want=String(columns).split(",").map(s=>s.trim()).filter(Boolean);
      const actual=want.map(k=>cm[k.toLowerCase()] ?? getCol(headers,k) ?? k);
      data=data.map(r=>{const o={}; actual.forEach(k=>o[k]=r[k]); return o;});
    }

    // ?filter_key=Paralelo&filter_val=A
    if(filter_key && filter_val!==undefined){
      const k=getCol(headers,filter_key) ?? filter_key;
      data=data.filter(r=>normalize(r[k])===normalize(filter_val));
    }

    // heurísticas por texto
    const qlow=q.toLowerCase();
    const wantsList=/(\blista|\blistado|\bmostrar|\bver|\bdespliega)\b/.test(qlow);
    const wantsRanking=/(ranking|mayor a menor|ordenar|top|rank)/.test(qlow);

    // “décimo a/b”, “paralelo a/b”, “sección a/b”, “ambos”
    let filtroCurso=null, filtroPar=null;
    const hayDecimo=/(decimo|d[eé]cimo)/.test(qlow); if(hayDecimo) filtroCurso="DECIMO";
    const mPar1=qlow.match(/(paralelo|secci[oó]n|grupo)\s*([ab])\b/i);
    const mPar2=qlow.match(/d[eé]cimo\s*([ab])\b/i);
    if(mPar1) filtroPar=mPar1[2].toUpperCase(); else if(mPar2) filtroPar=mPar2[1].toUpperCase();
    if(/\bamb[oa]s?\b/.test(qlow)) filtroPar=null;

    if(filtroCurso && colCurso){ data=data.filter(r=>normalize(r[colCurso]).includes(filtroCurso)); }
    if(filtroPar && colParalelo){ data=data.filter(r=>normalize(r[colParalelo])===filtroPar); }

    // feature específica (AGRESIÓN, EMPATÍA, TIMIDEZ, etc.)
    const featureMatch=qlow.match(/\b(agresividad|agresi[oó]n|empat[ií]a|timidez|f[ií]sico|autoestima|tensi[oó]n|ansiedad|promedio|nota|puntaje)\b/);
    if(featureMatch){
      const featNorm=normalize(featureMatch[1]);
      const kf=headers.find(h=>normalize(h).includes(featNorm));
      if(kf){
        data=data.map(r=>{
          const o={};
          if(colNombre) o[colNombre]=r[colNombre];
          o[kf]=r[kf];
          if(colParalelo) o[colParalelo]=r[colParalelo];
          if(colCurso) o[colCurso]=r[colCurso];
          return o;
        });
      }
    }

    // ranking
    if(wantsRanking){
      const hints=["Calificación","CALIFICACION","Calificacion","Promedio","Nota","Puntaje","Score","Total"];
      let metric=headers.find(h=>hints.some(w=>normalize(h).includes(normalize(w))));
      if(!metric) metric=firstNumericKey(data[0]||rows[0]);
      if(metric){ data=[...data].sort((a,b)=>(toNum(b[metric])||-Infinity)-(toNum(a[metric])||-Infinity)); }
    }

    // ?sort_by=
    if(sort_by){
      const key=getCol(headers,sort_by) ?? sort_by;
      data=[...data].sort((a,b)=>(toNum(b[key])||-Infinity)-(toNum(a[key])||-Infinity));
    }

    // limit
    let n=Number(limit); if(!Number.isFinite(n)||n<=0) n=data.length; data=data.slice(0,n);

    if(wantsList||wantsRanking||featureMatch||columns||filter_key||sort_by||format==="json"){
      res.setHeader("Content-Type","application/json; charset=utf-8");
      return res.status(200).json({ rows:data, ...(DEBUG && { debug:{headers,count:rows.length,file, colHints:{colNombre,colParalelo,colCurso}} }) });
    }

    const lines=data.slice(0,20).map((r,i)=>{
      const nom=colNombre? r[colNombre] : `Fila ${i+1}`;
      const par=colParalelo? `, Paralelo: ${r[colParalelo]}` : "";
      return `${i+1}. ${nom}${par}`;
    });
    res.setHeader("Content-Type","text/plain; charset=utf-8");
    return res.status(200).send(lines.join("\n"));

  }catch(err){
    console.error("ask.js error:",err);
    res.status(200).json({ error:true, message:"No se encontró respuesta (backend)", details:err?.message });
  }
};
