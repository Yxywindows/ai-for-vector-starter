from __future__ import annotations

import uuid

from fastapi import APIRouter, status

from app.db.session import SessionDep
from app.schemas.layer import LayerRead, LayerUpdate
from app.services import layer_service

router = APIRouter(prefix="/layers", tags=["layers"])


@router.get("/{layer_id}", response_model=LayerRead)
async def get_layer(layer_id: uuid.UUID, session: SessionDep) -> LayerRead:
    layer = await layer_service.get_layer_or_404(session, layer_id)
    return LayerRead.model_validate(layer)


@router.patch("/{layer_id}", response_model=LayerRead)
async def update_layer(
    layer_id: uuid.UUID,
    payload: LayerUpdate,
    session: SessionDep,
) -> LayerRead:
    layer = await layer_service.update_layer(session, layer_id, payload)
    return LayerRead.model_validate(layer)


@router.delete("/{layer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_layer(layer_id: uuid.UUID, session: SessionDep) -> None:
    await layer_service.delete_layer(session, layer_id)
