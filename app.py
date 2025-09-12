# app.py
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any
import csv, io, os, requests
from openai import OpenAI

app = FastAPI()

# CORS (en producción limita allow_origins a tu URL de Anvil)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],     # p.ej. ["https://TU-APP.anvil.app"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- Modelos ----------
class AskURLsBody(BaseModel):
    question: str
    urls: List[str]  # lista de URLs a CSV (Wix en tu caso)

# ---------- Utilidades CSV ----------
def sniff_delimiter(sample: str) -> str:
    try:
        return csv.Sniffer().sniff(sample, delimiters=[",",";","|","\t"]).delimiter
    except Exception:
        # heurística simple
        return ";" if ";" in sample and "," not in sample else ","

def fetch_csv_from_url(url: str, max_rows: int = 300) -> Dict[str, Any]:
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    text = r.text
    delim = sniff_delimiter(text[:5000])
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    rows = list(reader)

    name = url.split("/")[-1] or "archivo.csv"
    if not rows:
        return {"name": name, "columns": [], "rows": []}

    cols = [c.strip() for c in rows[0]]
    body = []
    for rrow in rows[1:max_rows+1]:
        # mapea col -> valor
        body.append({cols[i]: (rrow[i] if i < len(cols) else "") for i in range(len(cols))})
    return {"name": name, "columns": cols, "rows": body}

def compact_csv(csv_obj: Dict[str, Any], max_rows: int = 300) -> str:
    head = f"# {csv_obj['name']}\ncolumns: {', '.join(csv_obj['columns'])}\n"
    lines = []
    for i, row in enumerate(csv_obj["rows"][:max_rows], start=1):
        parts = [f"{k}={str(v).replace('\n',' ').replace('\r',' ')}" for k, v in row.items()]
        lines.append(f"{i}. " + "; ".join(parts))
    return head + "\n".join(lines)

def build_prompt(question: str, csvs: List[Dict[str, Any]]) -> str:
    parts = [
        "Eres un analista de datos. Responde SOLO usando el contenido de los CSV siguientes.",
        "Si los datos no alcanzan para una respuesta, dilo explícitamente.\n",
    ]
    for c in csvs:
        parts.append(compact_csv(c))
        parts.append("\n---\n")
    parts.append(f"Pregunta del usuario: {question}\nResponde en español, de forma concisa, "
                 f"y cita el/los archivo(s) por nombre cuando corresponda.")
    return "\n".join(parts)

def openai_answer(prompt: str) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY no configurada")
    client = OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model="gpt-4o-mini",  # usa el que tengas habilitado
        messages=[
            {"role": "system", "content": "You are a helpful data analyst."},
            {"role": "user", "content": prompt},
        ],
        temperature=0.2,
        max_tokens=800,
    )
    return resp.choices[0].message.content.strip()

# ---------- Endpoint principal: pregunta sobre URLs ----------
@app.post("/ask_urls")
def ask_urls(body: AskURLsBody):
    csvs = []
    for u in body.urls:
        try:
            csvs.append(fetch_csv_from_url(u))
        except Exception as e:
            csvs.append({"name": u, "columns": [], "rows": [], "error": str(e)})

    if not any(c.get("rows") for c in csvs):
        raise HTTPException(status_code=400, detail="No se pudo leer ningún CSV válido de las URLs.")

    prompt = build_prompt(body.question, csvs)
    try:
        answer = openai_answer(prompt)
        return {"answer": answer}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ------ Ping simple ------
@app.get("/")
def root():
    return {"message": "API ok"}
