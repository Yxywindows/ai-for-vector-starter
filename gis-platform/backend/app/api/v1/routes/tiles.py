from __future__ import annotations

import uuid

from fastapi import APIRouter, Path, Request, Response, status

from app.db.session import SessionDep
from app.services import raster_tile_service, tile_service

router = APIRouter(prefix="/layers/{layer_id}/tiles", tags=["tiles"])

MVT_MEDIA_TYPE = "application/vnd.mapbox-vector-tile"
PNG_MEDIA_TYPE = "image/png"
CACHE_CONTROL = "public, max-age=60"


@router.get(
    "/{z}/{x}/{y}.mvt",
    response_class=Response,
    responses={
        200: {"content": {MVT_MEDIA_TYPE: {}}},
        204: {"description": "No features in this tile"},
        304: {"description": "Not modified"},
    },
)
async def vector_tile(
    request: Request,
    layer_id: uuid.UUID,
    session: SessionDep,
    z: int = Path(...),
    x: int = Path(...),
    y: int = Path(...),
) -> Response:
    blob, layer = await tile_service.get_vector_tile(session, layer_id, z, x, y)
    etag = tile_service.tile_etag(layer, z, x, y)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if not blob:
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers=headers)
    return Response(content=blob, media_type=MVT_MEDIA_TYPE, headers=headers)


@router.get(
    "/{z}/{x}/{y}.png",
    response_class=Response,
    responses={
        200: {"content": {PNG_MEDIA_TYPE: {}}},
        204: {"description": "Tile is outside the raster"},
        304: {"description": "Not modified"},
    },
)
async def raster_tile(
    request: Request,
    layer_id: uuid.UUID,
    session: SessionDep,
    z: int = Path(...),
    x: int = Path(...),
    y: int = Path(...),
) -> Response:
    png, layer = await raster_tile_service.render_png(session, layer_id, z, x, y)
    etag = tile_service.tile_etag(layer, z, x, y)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if png is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers=headers)
    return Response(content=png, media_type=PNG_MEDIA_TYPE, headers=headers)
