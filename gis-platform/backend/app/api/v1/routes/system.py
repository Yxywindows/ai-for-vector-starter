from fastapi import APIRouter

from app.schemas.system import MemoryReport
from app.services import system_service

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/memory", response_model=MemoryReport)
def memory() -> MemoryReport:
    return system_service.memory_report()
