from fastapi import APIRouter

from app.api.v1.routes import catalog, features, health, imports, layers, projects, tiles

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(projects.router)
api_router.include_router(layers.router)
api_router.include_router(catalog.router)
api_router.include_router(imports.router)
api_router.include_router(features.router)
api_router.include_router(tiles.router)
