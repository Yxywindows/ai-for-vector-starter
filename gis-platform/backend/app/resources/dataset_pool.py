"""An async LRU pool of expensive, non-thread-safe dataset handles.

Opening a GeoTIFF is not free: GDAL parses the header, the internal tiling
scheme and the overview table. At one open per tile request a raster layer
would spend most of its time in `open()`. The pool keeps handles alive
between requests, bounded two ways — `max_open` (how many at once) and
`idle_ttl` (how long an unused one may linger).

Access is EXCLUSIVE per key. A rasterio dataset is not thread-safe, and
tile reads run on worker threads, so two concurrent reads of the same file
must serialise. Different files never block each other. The trade-off is
deliberate: correctness over per-file concurrency. Scaling one file across
cores would need N handles per key, which is future work.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from app.core.errors import ServiceUnavailableError
from app.schemas.system import PoolStats

logger = logging.getLogger(__name__)


@dataclass
class _Entry[T]:
    handle: T
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    in_use: int = 0
    last_used: float = 0.0


class DatasetPool[T]:
    def __init__(
        self,
        *,
        factory: Callable[[str], T],
        closer: Callable[[T], None],
        max_open: int,
        idle_ttl: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._factory = factory
        self._closer = closer
        self._max_open = max_open
        self._idle_ttl = idle_ttl
        self._clock = clock
        self._entries: OrderedDict[str, _Entry[T]] = OrderedDict()
        self._guard = asyncio.Lock()
        self._hits = 0
        self._misses = 0
        self._evictions = 0

    @asynccontextmanager
    async def acquire(self, key: str) -> AsyncIterator[T]:
        entry = await self._checkout(key)
        try:
            async with entry.lock:
                yield entry.handle
        finally:
            async with self._guard:
                entry.in_use -= 1
                entry.last_used = self._clock()
                self._entries.move_to_end(key)
                await self._enforce_capacity()

    async def _checkout(self, key: str) -> _Entry[T]:
        async with self._guard:
            entry = self._entries.get(key)
            if entry is not None:
                self._hits += 1
                entry.in_use += 1
                entry.last_used = self._clock()
                self._entries.move_to_end(key)
                return entry

            self._misses += 1
            try:
                handle = self._factory(key)
            except Exception:
                logger.exception("Failed to open dataset %s", key)
                raise
            entry = _Entry(handle=handle, in_use=1, last_used=self._clock())
            self._entries[key] = entry
            await self._enforce_capacity()
            return entry

    async def _enforce_capacity(self) -> None:
        """Caller must hold self._guard. Closes idle handles, oldest first."""
        for key in list(self._entries.keys()):
            if len(self._entries) <= self._max_open:
                return
            entry = self._entries[key]
            if entry.in_use > 0:
                continue  # never close a handle someone is reading
            self._close_entry(key, entry)
            self._evictions += 1

    def _close_entry(self, key: str, entry: _Entry[T]) -> None:
        try:
            self._closer(entry.handle)
        except Exception:  # a failing close must not poison the pool
            logger.exception("Failed to close dataset %s", key)
        finally:
            self._entries.pop(key, None)

    async def evict_idle(self) -> int:
        now = self._clock()
        removed = 0
        async with self._guard:
            for key in list(self._entries.keys()):
                entry = self._entries[key]
                if entry.in_use == 0 and now - entry.last_used >= self._idle_ttl:
                    self._close_entry(key, entry)
                    self._evictions += 1
                    removed += 1
        return removed

    async def close_all(self) -> None:
        async with self._guard:
            for key in list(self._entries.keys()):
                self._close_entry(key, self._entries[key])

    def stats(self) -> PoolStats:
        return PoolStats(
            open_handles=len(self._entries),
            max_open=self._max_open,
            idle_ttl_seconds=self._idle_ttl,
            hits=self._hits,
            misses=self._misses,
            evictions=self._evictions,
            keys=list(self._entries.keys()),
        )


_raster_pool: DatasetPool[object] | None = None


def set_raster_pool(pool: DatasetPool[object]) -> None:
    global _raster_pool
    _raster_pool = pool


def get_raster_pool() -> DatasetPool[object]:
    if _raster_pool is None:
        raise ServiceUnavailableError(
            "The raster dataset pool has not been initialised -- "
            "the application lifespan has not run yet"
        )
    return _raster_pool
