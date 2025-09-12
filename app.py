import os
import pandas as pd
import httpx
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from openai import OpenAI

# Inicializar FastAPI
app = FastAPI()

# Configuración de OpenAI
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5")  # Usa GPT-5 por defecto

client = OpenAI(api_key=OPENAI_API_KEY)

# URLs de los CSV en Wix
CSV_URL_1 = "https://c49ab423-34f3-4867-adc6-30616c95bb16.usrfiles.com/ugd/c49ab4_39ce3d9b883f47be8ceb0b12f5bc94ad.csv"
CSV_URL_2 = "https://c49ab423-34f3-4867-adc6-30616c95bb16.usrfiles.com/ugd/c49ab4_ecb22fee2d8f49b692ee5cf0d2c18b58.csv"

# Función para cargar CSV desde URL
async def load_csv_from_url(url: str):
    async with httpx.AsyncClient() as client_http:
        response = await client_http.get(url)
        response.raise_for_status()
        return pd.read_csv(pd.compat.StringIO(response.text))

# Endpoint para cargar y mostrar CSV
@app.get("/load_csv")
async def load_csv():
    try:
        df1 = await load_csv_from_url(CSV_URL_1)
        df2 = await load_csv_from_url(CSV_URL_2)

        # Mostrar solo primeras filas para confirmar carga
        return {
            "message": "CSV cargados correctamente",
            "csv1_preview": df1.head(5).to_dict(),
            "csv2_preview": df2.head(5).to_dict()
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

# Endpoint para hacer preguntas usando GPT-5
@app.get("/ask")
async def ask_question(query: str = Query(..., description="Pregunta sobre los CSV")):
    try:
        # Cargar los CSV
        df1 = await load_csv_from_url(CSV_URL_1)
        df2 = await load_csv_from_url(CSV_URL_2)

        # Convertir CSVs a texto para pasarlos al modelo
        combined_data = f"CSV 1:\n{df1.head(10).to_string()}\n\nCSV 2:\n{df2.head(10).to_string()}"

        # Enviar a GPT-5
        prompt = f"""
        Eres un asistente experto en análisis de datos.
        Aquí tienes datos de dos archivos CSV. Responde estrictamente basado en esta información.

        {combined_data}

        Pregunta: {query}
        """

        response = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": "Eres un experto en análisis de datos CSV."},
                {"role": "user", "content": prompt}
            ]
        )

        answer = response.choices[0].message["content"]

        return {
            "model_used": OPENAI_MODEL,
            "question": query,
            "answer": answer
        }

    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

# Endpoint raíz para comprobar servicio
@app.get("/")
async def root():
    return {
        "message": "Backend funcionando correctamente",
        "model_in_use": OPENAI_MODEL
    }
