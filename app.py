# app.py
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any
import os, csv, io, requests
from openai import OpenAI

app = FastAPI(
    title="CSV QA Backend",
    description="Descarga CSV desde URLs, construye contexto y pregunta al modelo de OpenAI de forma estricta.",
    version="1.0.0",
)

# ====== CONFIG ======
# Lee la clave de OpenAI desde variables de entorno (configúrala en Render → Settings → Environment).
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")  # requerido
# Modelo por defecto (puedes cambiarlo a 'gpt-5' si tu cuenta lo tiene habilitado)
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5")  # p.ej. gpt-5, gpt-4o-mini, etc.
MAX_ROWS_PER_CSV = int(os.getenv("MAX_ROWS_PER_CSV", "300"))

if not OPENAI_API_KEY:
    # No levantamos excepción aquí para que /docs y / funcionen; validamos al invocar OpenAI
    pass

# CORS: en producción cambia allow_origins a tu dominio de Anvil
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],            # Ej: ["https://TU-APP.anvil.app"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ====== Esquemas ======
class AskURLsBody(BaseModel):
    question: str
    urls: List[str]

# ====== Utilidades CSV ======
def sniff_delimiter(sample: str) -> str:
    try:
        return csv.Sniffer().sniff(sample, delimiters=[",",";","|","\t"]).delimiter
    except Exception:
        # heurística simple
        return ";" if ";" in sample and "," not in sample else ","

def fetch_csv_from_url(url: str, max_rows: int = MAX_ROWS_PER_CSV) -> Dict[str, Any]:
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
        body.append({cols[i]: (rrow[i] if i < len(cols) else "") for i in range(len(cols))})
    return {"name": name, "columns": cols, "rows": body}

def compact_csv(csv_obj: Dict[str, Any], max_rows: int = MAX_ROWS_PER_CSV) -> str:
    head = f"# {csv_obj['name']}\ncolumns: {', '.join(csv_obj['columns'])}\n"
    lines = []
    for i, row in enumerate(csv_obj["rows"][:max_rows], start=1):
        # col=valor; col=valor
        parts = []
        for k in csv_obj["columns"]:
            v = str(row.get(k, "")).replace("\n"," ").replace("\r"," ")
            parts.append(f"{k}={v}")
        lines.append(f"{i}. " + "; ".join(parts))
    return head + "\n".join(lines)

def build_prompt_strict(question: str, csvs: List[Dict[str, Any]]) -> str:
    """
    Prompt ESTRICTO: solo usa datos de los CSV.
    Si falta información, obliga a decirlo explícitamente.
    """
    parts = [
        "Eres un analista de datos ESTRICTO.",
        "REGLAS:",
        "1) SOLO puedes usar información que aparezca en el contexto CSV provisto.",
        "2) Si la respuesta no está en los datos, responde exactamente: 'No hay datos suficientes para responder.'",
        "3) Responde en español, de forma concisa.",
        "4) Cuando cites datos, menciona archivo y columna(s).",
        "5) No inventes, no uses conocimiento externo.\n",
        "=== CONTEXTO CSV ===\n",
    ]
    for c in csvs:
        parts.append(compact_csv(c))
        parts.append("\n---\n")
    parts.append(f"=== PREGUNTA ===\n{question}\n")
    parts.append("=== INSTRUCCIÓN FINAL ===\nResponde cumpliendo las reglas anteriores.")
    return "\n".join(parts)

def openai_answer_strict(prompt: str) -> str:
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY no configurada en el entorno.")
    client = OpenAI(api_key=OPENAI_API_KEY)

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system",
             "content": (
                 "Eres un analista de datos muy estricto. "
                 "Si la información no está presente en el contexto, responde "
                 "'No hay datos suficientes para responder.'"
             )},
            {"role": "user", "content": prompt},
        ],
        temperature=0.1,   # más bajo = más estricto
        max_tokens=900,
    )
    return resp.choices[0].message.content.strip()

# ====== Endpoints ======
@app.get("/")
def root():
    return {"message": "API ok"}

@app.get("/model")
def current_model():
    """
    Devuelve el nombre del modelo configurado (para mostrarlo en Anvil).
    """
    return {"model": OPENAI_MODEL}

@app.post("/ask_urls")
def ask_urls(body: AskURLsBody):
    """
    Descarga CSV desde las URLs, construye el contexto y pregunta de forma estricta.
    Devuelve la respuesta y el modelo utilizado.
    """
    csvs = []
    for u in body.urls:
        try:
            csvs.append(fetch_csv_from_url(u))
        except Exception as e:
            csvs.append({"name": u, "columns": [], "rows": [], "error": str(e)})

    if not any(c.get("rows") for c in csvs):
        raise HTTPException(status_code=400, detail="No se pudo leer ningún CSV válido desde las URLs.")

    prompt = build_prompt_strict(body.question, csvs)
    answer = openai_answer_strict(prompt)

    # Anexamos el modelo explícitamente
    return {"answer": answer, "model": OPENAI_MODEL}
