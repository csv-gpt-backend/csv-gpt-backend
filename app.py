# app.py
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any
import os, csv, io, requests
from openai import OpenAI

app = FastAPI(
    title="CSV + GPT Backend (Railway)",
    description="Descarga 2 CSV desde Wix y responde preguntas estrictamente con el modelo configurado.",
    version="1.0.0",
)

# ===== Config =====
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")              # ponla en Railway → Variables
OPENAI_MODEL   = os.getenv("OPENAI_MODEL", "gpt-5")       # gpt-5 si lo tienes; si no, cambia aquí o en Variables
MAX_ROWS       = 100

# Tus CSV de Wix (sin subir manualmente)
CSV_URLS = [
    "https://c49ab423-34f3-4867-adc6-30616c95bb16.usrfiles.com/ugd/c49ab4_39ce3d9b883f47be8ceb0b12f5bc94ad.csv",
    "https://c49ab423-34f3-4867-adc6-30616c95bb16.usrfiles.com/ugd/c49ab4_ecb22fee2d8f49b692ee5cf0d2c18b58.csv"
]

# CORS: permite llamadas desde Anvil
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # en prod limita a tu dominio de Anvil
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ===== Schemas =====
class AskBody(BaseModel):
    question: str

# ===== CSV utils =====
def sniff_delimiter(sample: str) -> str:
    try:
        return csv.Sniffer().sniff(sample, delimiters=[",",";","\t","|"]).delimiter
    except Exception:
        return ";" if ";" in sample and "," not in sample else ","

def fetch_csv(url: str) -> Dict[str, Any]:
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
    for rrow in rows[1:MAX_ROWS+1]:
        body.append({cols[i]: (rrow[i] if i < len(rrow) else "") for i in range(len(cols))})
    return {"name": name, "columns": cols, "rows": body}

def compact_csv_for_prompt(csv_obj: Dict[str, Any]) -> str:
    head = f"# {csv_obj['name']}\ncolumns: {', '.join(csv_obj['columns'])}\n"
    lines = []
    for i, row in enumerate(csv_obj["rows"], start=1):
        parts = [f"{k}={row.get(k, '')}" for k in csv_obj["columns"]]
        lines.append(f"{i}. " + "; ".join(parts))
    return head + "\n".join(lines)

# ===== GPT strict =====
def build_prompt(question: str, csvs: List[Dict[str, Any]]) -> str:
    return "\n".join([
        "Eres un analista de datos ESTRICTO.",
        "REGLAS:",
        "1) SOLO usa información que aparece en los CSV.",
        "2) Si no existe información suficiente, responde exactamente: 'No hay datos suficientes para responder.'",
        "3) Responde en español, claro y conciso.\n",
        "=== CONTEXTO CSV ===",
        *[compact_csv_for_prompt(c) for c in csvs],
        "\n=== PREGUNTA ===",
        question
    ])

def ask_gpt(prompt: str) -> str:
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY no configurada.")
    client = OpenAI(api_key=OPENAI_API_KEY)
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,  # gpt-5 si lo tienes; si no, ajusta en Variables
        messages=[
            {"role": "system", "content": "Eres un analista de datos estricto."},
            {"role": "user", "content": prompt}
        ],
        temperature=0.1,
        max_tokens=900
    )
    return resp.choices[0].message.content.strip()

# ===== Endpoints =====
@app.get("/")
def root():
    return {"message": "Backend listo", "model": OPENAI_MODEL}

@app.get("/preview")
def preview():
    previews = []
    for u in CSV_URLS:
        data = fetch_csv(u)
        previews.append({
            "url": u,
            "name": data["name"],
            "columns": data["columns"],
            "rows_count": len(data["rows"]),
            "sample": data["rows"][:5]
        })
    return {"previews": previews}

@app.post("/ask")
def ask(body: AskBody):
    csvs = [fetch_csv(u) for u in CSV_URLS]
    if not any(c["rows"] for c in csvs):
        raise HTTPException(status_code=400, detail="No se pudo leer datos de los CSV.")
    prompt = build_prompt(body.question, csvs)
    answer = ask_gpt(prompt)
    return {
        "answer": answer,
        "model": OPENAI_MODEL,
        "files": [{"name": c["name"], "rows_count": len(c["rows"])} for c in csvs]
    }
