from fastapi import FastAPI
import os

# Crear la aplicación FastAPI
app = FastAPI()

# Ruta de prueba
@app.get("/")
def read_root():
    return {"message": "¡API funcionando correctamente!"}

# Endpoint para verificar variables de entorno
@app.get("/check-env")
def check_env():
    api_key = os.getenv("OPENAI_API_KEY", "No encontrado")
    return {"OPENAI_API_KEY": api_key}
