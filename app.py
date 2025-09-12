from dotenv import load_dotenv
load_dotenv()
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict
from openai import OpenAI

app = FastAPI()

# Permite que tu frontend en Anvil pueda conectarse
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Puedes poner solo tu dominio de Anvil para más seguridad
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Clave de OpenAI desde variable de entorno
client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

class CSV(BaseModel):
    name: str | None = None
    columns: List[str]
    rows: List[Dict[str, str]]

class AskBody(BaseModel):
    question: str
    csvs: List[CSV]

def compact_csv(c: CSV) -> str:
    cols = c.columns or []
    rows = c.rows or []
    out = [f"== ARCHIVO: {c.name or 'CSV'} ==", "COLUMNAS: " + ", ".join(cols)]
    for r in rows[:300]:  # límite de filas para no saturar GPT
        vals = [str(r.get(col, "")) for col in cols]
        out.append("|".join(vals))
    return "\n".join(out)

@app.post("/ask")
def ask(body: AskBody):
    context_parts = [compact_csv(c) for c in body.csvs]
    context_text = "\n\n".join(context_parts)
    
    if len(context_text) > 120_000:
        context_text = context_text[:120_000] + "\n[...truncado...]"

    system = (
        "Eres un analista de datos. Responde en español latino, breve y con citas "
        "a columnas y valores concretos del CSV. Si falta información, dilo claramente."
    )
    user = f"Pregunta: {body.question}\n\nContexto CSV:\n{context_text}"

    resp = client.chat.completions.create(
        model="gpt-4o-mini",  # o gpt-5 si tu cuenta lo tiene habilitado
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        temperature=0.2
    )

    answer = resp.choices[0].message.content
    return {"answer": answer}
