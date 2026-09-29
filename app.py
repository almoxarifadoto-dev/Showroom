from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, FileResponse
import os

app = FastAPI()
DB_PATH = "showroom.db"

@app.get("/")
def read_root():
    with open("showroom.html", "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read())

@app.get("/load_db")
def load_db():
    if os.path.exists(DB_PATH):
        return FileResponse(DB_PATH, media_type="application/octet-stream")
    return Response(status_code=404)

@app.get("/download_db")
def download_db():
    if os.path.exists(DB_PATH):
        return FileResponse(
            DB_PATH, 
            media_type="application/octet-stream", 
            filename="showroom_backup.db"
        )
    return Response(status_code=404, content="Banco de dados não encontrado.")

@app.post("/save_db")
async def save_db(request: Request):
    data = await request.body()
    with open(DB_PATH, "wb") as f:
        f.write(data)
    return {"status": "sucesso"}

@app.get("/catalogo.js")
def get_catalogo():
    if os.path.exists("catalogo.js"):
        return FileResponse("catalogo.js")
    return Response(status_code=404)
