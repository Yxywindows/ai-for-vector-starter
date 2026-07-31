from fastapi import APIRouter

from app.schemas.system import ImportLimits, MemoryReport
from app.services import system_service

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/memory", response_model=MemoryReport)
def memory() -> MemoryReport:
    return system_service.memory_report()


@router.get("/import-limits", response_model=ImportLimits)
def import_limits() -> ImportLimits:
    return system_service.import_limits()
