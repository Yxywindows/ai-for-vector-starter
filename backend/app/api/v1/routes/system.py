from fastapi import APIRouter

from app.db.session import SessionDep
from app.schemas.system import ImportLimits, MemoryReport, SystemOverview
from app.services import system_service

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/memory", response_model=MemoryReport)
def memory() -> MemoryReport:
    return system_service.memory_report()


@router.get("/import-limits", response_model=ImportLimits)
def import_limits() -> ImportLimits:
    return system_service.import_limits()


@router.get("/overview", response_model=SystemOverview)
async def overview(session: SessionDep) -> SystemOverview:
    return await system_service.overview(session)
