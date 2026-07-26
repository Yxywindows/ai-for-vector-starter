from fastapi import APIRouter

from app.api.v1.routes import health, layers, projects

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(projects.router)
api_router.include_router(layers.router)
