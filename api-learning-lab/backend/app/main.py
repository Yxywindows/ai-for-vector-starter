from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.controller import dataset_controller, upload_controller

app = FastAPI(
    title="API Learning Lab",
    description="A standalone playground for practicing REST API design: "
    "path/query params, headers, request bodies, multipart upload, and CRUD.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(dataset_controller.router)
app.include_router(upload_controller.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
