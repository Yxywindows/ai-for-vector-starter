from fastapi import APIRouter

from app.core.config import Settings, get_settings

router = APIRouter(tags=["system"])


@router.get("/health")
def health() -> dict[str, str]:
    settings: Settings = get_settings()
    return {"status": "ok", "environment": settings.environment}
