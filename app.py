# app.py (SMOKE TEST, sin OpenAI)
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import csv, io, requests

app = FastAPI(title="CSV Smoke Test")

# Tus CSV en Wix
CSV_URLS = [
    "https://c49ab423-34f3-4867-adc6-30616c95bb16.usrfiles.com/ugd/c49ab4_39ce3d9b883f47be8ceb0b12f5bc94ad.csv",
    "https://c49ab423-34f3-4867-adc6-30616c95bb16.usrfiles.com/ugd/c49ab4_ecb22fee2d8f49b692ee5cf0d2c18b58.csv"
]

# CORS abierto para que Anvil pueda llamar
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _sniff(sample: str) -> str:
    try:
        return csv.Sniffer().sniff(sample, delimiters=[",",";","\t","|"]).delimiter
    except Exception:
        return ";" if ";" in sample and "," not in sample else ","

def _fetch_csv(url: str, max_rows=10):
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    text = r.text
    delim = _sniff(text[:5000])
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

@app.get("/")
def root():
    return {"ok": True, "msg": "Backend SMOKE listo (sin OpenAI)"}

@app.get("/preview")
def preview():
    out = []
    for u in CSV_URLS:
        try:
            d = _fetch_csv(u)
            out.append({
                "url": u,
                "name": d["name"],
                "columns": d["columns"],
                "rows_count": len(d["rows"]),
                "sample": d["rows"][:5],
            })
        except Exception as e:
            out.append({"url": u, "error": str(e)})
    return {"previews": out}
