# app.py
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any
import os, csv, io, requests
from openai import OpenAI

app = FastAPI(title="CSV GPT5 QA")

# ===== Configuración =====
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5")  # Forzar gpt-5 por defecto
MAX_ROWS = 300  # Número máximo de filas a procesar por CSV

# CORS (permite llamadas desde Anvil)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # luego limita a tu dominio Anvil
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ===== Schemas =====
class AskBody(BaseModel):
    question: str
    urls: List[str]

# ===== Utilidades CSV =====
def sniff_delimiter(sample: str) -> str:
    try:
        return csv.Sniffer().sniff(sample, delimiters=[",",";","\t"]).delimiter
    except:
        return ";" if ";" in sample and "," not in sample else ","

def fetch_csv(url: str, max_rows=MAX_ROWS) -> Dict[str, Any]:
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    text = r.text
    delim = sniff_delimiter(text[:5000])
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    rows = list(reader)

    name = url.split("/")[-1] or "archivo.csv"
    if not rows:
        return {"name": name, "columns": [], "rows": []}

    columns = [c.strip() for c in rows[0]]
    data = []
    for rrow in rows[1:max_rows+1]:
        data.append({columns[i]: rrow[i] if i < len(rrow) else "" for i in range(len(columns))})

    return {"name": name, "columns": columns, "rows": data}

# ===== GPT =====
def build_prompt(question: str, csvs: List[Dict[str, Any]]) -> str:
    context_parts = [
        "Eres un analista de datos ESTRICTO.",
        "Reglas:",
        "1) SOLO usa la información contenida en los CSV.",
        "2) Si no hay datos suficientes, responde exactamente: 'No hay datos suficientes para responder.'",
        "3) Responde en español, claro y conciso.\n",
        "=== CONTEXTO CSV ===\n",
    ]
    for csv_obj in csvs:
        context_parts.append(f"# {csv_obj['name']}\nColumnas: {', '.join(csv_obj['columns'])}\n")
        for i, row in enumerate(csv_obj["rows"][:5], start=1):  # solo las primeras 5 filas
            context_parts.append(f"{i}. " + "; ".join(f"{k}={v}" for k, v in row.items()))
        context_parts.append("\n---\n")
    context_parts.append(f"=== PREGUNTA ===\n{question}")
    return "\n".join(context_parts)

def ask_gpt(prompt: str) -> str:
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY no configurada")
    client = OpenAI(api_key=OPENAI_API_KEY)
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": "Eres un analista de datos estricto y preciso."},
            {"role": "user", "content": prompt}
        ],
        temperature=0.1,
        max_tokens=800
    )
    return resp.choices[0].message.content.strip()

# ===== Endpoints =====
@app.get("/ping")
def ping():
    return {"status": "ok"}

@app.get("/model")
def model_name():
    return {"model": OPENAI_MODEL}

@app.post("/ask")
def ask(body: AskBody):
    csvs = []
    confirmations = []
    for url in body.urls:
        try:
            d = fetch_csv(url)
            csvs.append(d)
            confirmations.append({
                "name": d["name"],
                "columns": len(d["columns"]),
                "rows": len(d["rows"])
            })
        except Exception as e:
            confirmations.append({"name": url, "error": str(e)})

    if not any(c["rows"] for c in csvs if "rows" in c):
        raise HTTPException(status_code=400, detail="No se pudo leer ningún CSV válido.")

    prompt = build_prompt(body.question, csvs)
    answer = ask_gpt(prompt)
    return {
        "answer": answer,
        "model": OPENAI_MODEL,
        "csvs_loaded": confirmations
    }
