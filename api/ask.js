const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

function setCors(res){res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");}
function tryRead(f,e){try{return fs.readFileSync(f,e);}catch{return null;}}
function guessDelimiter(s){s=s||"";const sc=(s.match(/;/g)||[]).length;const cc=(s.match(/,/g)||[]).length;return sc>cc?";":",";}
function findNameKey(h){const c=["Nombre","NOMBRE","Apellidos y Nombres","APELLIDOS Y NOMBRES","Estudiante","ESTUDIANTE"];const l=h.map(x=>x.toLowerCase());for(const k of c){const i=l.indexOf(k.toLowerCase());if(i>=0)return h[i];}return h[0];}
function toNumberOrNull(v){if(v==null)return null;const n=Number(String(v).replace(",","."));return Number.isFinite(n)?n:null;}
function mean(arr){const a=arr.map(toNumberOrNull).filter(n=>n!==null);if(!a.length)return null;return a.reduce((s,n)=>s+n,0)/a.length;}

module.exports = async (req,res)=>{
  setCors(res); if(req.method==="OPTIONS"){res.statusCode=200;return res.end();}
  try{
    const url = new URL(req.url,"http://localhost");
    const alumnoQ=(url.searchParams.get("alumno")||"").trim();
    const camposQ=(url.searchParams.get("campos")||"").trim();
    const fuente =(url.searchParams.get("fuente") ||"Ambos").trim();
    if(!alumnoQ){res.statusCode=400;res.setHeader("Content-Type","application/json; charset=utf-8");return res.end(JSON.stringify({ok:false,error:"Falta el parámetro 'alumno'."}));}

    const csvPath=path.join(process.cwd(),"public","datos.csv");
    let csv=tryRead(csvPath,"utf8"); if(!csv) csv=tryRead(csvPath,"latin1");
    if(!csv){res.statusCode=500;res.setHeader("Content-Type","application/json; charset=utf-8");return res.end(JSON.stringify({ok:false,error:"No se pudo leer public/datos.csv"}));}

    const delimiter=guessDelimiter(csv.slice(0,5000));
    const records=parse(csv,{delimiter,columns:true,skip_empty_lines:true,trim:true});
    if(!records.length){res.statusCode=400;res.setHeader("Content-Type","application/json; charset=utf-8");return res.end(JSON.stringify({ok:false,error:"CSV vacío o sin cabeceras."}));}

    const headers=Object.keys(records[0]);
    const nameKey=findNameKey(headers);

    const gCands=["Grupo","GRUPO","Paralelo","PARALELO","Curso","CURSO","Sección","SECCIÓN"];
    const lh=headers.map(h=>h.toLowerCase()); let groupKey=null;
    for(const c of gCands){const i=lh.indexOf(c.toLowerCase()); if(i>=0){groupKey=headers[i];break;}}

    let data=records; const wantA=fuente.toLowerCase()==="a"; const wantB=fuente.toLowerCase()==="b";
    if(groupKey && (wantA || wantB)){
      data=data.filter(r=>{const g=(r[groupKey]||"").toString().toUpperCase(); return wantA?g.includes("A"):g.includes("B");});
    }

    const alumno=data.find(r=>(r[nameKey]||"").toLowerCase().includes(alumnoQ.toLowerCase()));
    if(!alumno){res.statusCode=404;res.setHeader("Content-Type","application/json; charset=utf-8");return res.end(JSON.stringify({ok:false,error:`No se encontró alumno que coincida con "${alumnoQ}".`}));}

    const metricKeysDefault=["AUTOESTIMA","EMPATIA","FISICO","TENSION","RESPONSABILIDAD","COOPERACION"];
    let metricKeys=metricKeysDefault.filter(k=>headers.includes(k));
    if(camposQ){
      const asked=camposQ.split(",").map(s=>s.trim()).filter(Boolean);
      metricKeys=asked.filter(k=>headers.includes(k));
      if(!metricKeys.length){res.statusCode=400;res.setHeader("Content-Type","application/json; charset=utf-8");return res.end(JSON.stringify({ok:false,error:`Ninguna columna coincide con 'campos'. Disponibles: ${headers.join(", ")}`}));}
    }

    let dataA=data, dataB=data, dataT=data;
    if(groupKey){
      dataA=data.filter(r=>(r[groupKey]||"").toString().toUpperCase().includes("A"));
      dataB=data.filter(r=>(r[groupKey]||"").toString().toUpperCase().includes("B"));
    }

    const rows=metricKeys.map(k=>{
      const v=toNumberOrNull(alumno[k]);
      const mA=mean(dataA.map(r=>r[k]));
      const mB=mean(dataB.map(r=>r[k]));
      const mT=mean(dataT.map(r=>r[k]));
      return {campo:k, alumno:v, grupo_A:mA, grupo_B:mB, grupo_total:mT};
    });

    const payload={ok:true, alumno:alumno[nameKey], fuente, nameKey, groupKey:groupKey||null, n_A:groupKey?dataA.length:null, n_B:groupKey?dataB.length:null, n_total:dataT.length, rows};
    res.statusCode=200; res.setHeader("Content-Type","application/json; charset=utf-8"); res.end(JSON.stringify(payload));
  }catch(err){console.error(err);res.statusCode=500;res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify({ok:false,error:"Error interno",details:String(err&&err.message||err)}));}
};
