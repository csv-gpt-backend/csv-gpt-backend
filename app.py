from fastapi import FastAPI
import os

app = FastAPI()

@app.get("/")
def root():
    return {"message": "API ok"}

@app.get("/check-env")
def check_env():
    return {"OPENAI_API_KEY": os.getenv("OPENAI_API_KEY", "not set")}
