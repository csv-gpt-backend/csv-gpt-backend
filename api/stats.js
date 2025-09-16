const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

function setCors(res){res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");}
function tryRead(f,e){try{return fs.readFileSync(f,e);}catch{return null;}}
function guessDelimiter(s){s=s||"";const sc=(s.match(/;/g)||[]).length;const cc=(s.match(/,/g)||[]).length;return sc>cc?";":",";}
function toNumberOrNull(v){if(v==null)return null;const n=Number(String(v).replace(",","."));return Number.isFinite(n)?n:null;}
function stats(arr, key){
  const nums=arr.map(r=>toNumberOrNull(r[key])).filter(n=>n!==null);
  if(!nums.length) return {n:0, mean:null, min:null, max:null};
  const n=nums.length;
  const mean=nums.reduce((s,x)=>s+x,0)/n;
  let min=nums[0], max=nums[0];
  for(const x of nums){if(x<min)min=x; if(x>max)max=x;}
  return {n, mean, min, max};
}

module.exports = async (req,res)=>{
  setCors(res); if(req.method==="OPTIONS"){res.statusCode=200;return res.end();}
  try{
    const url=new URL(req.url,"http://localhost");
    const campo =(url.searchParams.get("campo")  || "").trim();
    const fuente=(url.searchParams.get("fuente") || "Ambos").trim();
    if(!campo){res.statusCode=400;res.setHeader("Content-Type","application/json; charset=utf-8");return res.end(JSON.stringify({ok:false,error:"Falta el parámetro 'campo'."}));}

    const csvPath=path.join(process.cwd(),"public","datos.csv");
    let csv=tryRead(csvPath,"utf8"); if(!csv) csv=tryRead(csvPath,"latin1");
    if(!csv){res.statusCode=500;res.setHeader("Content-Type","application/json; charset=utf-8");return res.end(JSON.stringify({ok:false,error:"No se pudo leer public/datos.csv"}));}

    const delimiter=guessDelimiter(csv.slice(0,5000));
    const records=parse(csv,{delimiter,columns:true,skip_empty_lines:true,trim:true});
    if(!records.length){res.statusCode=400;res.setHeader("Content-Type","application/json; charset=utf-8");return res.end(JSON.stringify({ok:false,error:"CSV vacío o sin cabeceras."}));}

    const headers=Object.keys(records[0]);
    if(!headers.includes(campo)){res.statusCode=400;res.setHeader("Content-Type","application/json; charset=utf-8");return res.end(JSON.stringify({ok:false,error:`El campo '${campo}' no existe. Disponibles: ${headers.join(", ")}`}));}

    const gCands=["Grupo","GRUPO","Paralelo","PARALELO","Curso","CURSO","Sección","SECCIÓN"];
    const lh=headers.map(h=>h.toLowerCase()); let groupKey=null;
    for(const c of gCands){const i=lh.indexOf(c.toLowerCase()); if(i>=0){groupKey=headers[i];break;}}

    let data=records; const wantA=fuente.toLowerCase()==="a"; const wantB=fuente.toLowerCase()==="b";
    if(groupKey && (wantA||wantB)){
      data=data.filter(r=>{const g=(r[groupKey]||"").toString().toUpperCase(); return wantA?g.includes("A"):g.includes("B");});
    }

    let dataA=data, dataB=data;
    if(groupKey){
      dataA=data.filter(r=>(r[groupKey]||"").toString().toUpperCase().includes("A"));
      dataB=data.filter(r=>(r[groupKey]||"").toString().toUpperCase().includes("B"));
    }

    const out={ total: stats(data,campo) };
    if(groupKey){ out.A = stats(dataA,campo); out.B = stats(dataB,campo); }

    res.statusCode=200; res.setHeader("Content-Type","application/json; charset=utf-8");
    res.end(JSON.stringify({ok:true, campo, fuente, groupKey:groupKey||null, stats:out}));
  }catch(err){console.error(err);res.statusCode=500;res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify({ok:false,error:"Error interno",details:String(err&&err.message||err)}));}
};
