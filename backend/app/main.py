from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="AI For Vector API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:1314"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/sample-points")
def sample_points():
    """Placeholder map data — swap for your own imagery/vector sources."""
    return {
        "points": [
            {"id": 1, "lat": 39.9042, "lng": 116.4074, "label": "Beijing"},
            {"id": 2, "lat": 31.2304, "lng": 121.4737, "label": "Shanghai"},
        ]
    }
