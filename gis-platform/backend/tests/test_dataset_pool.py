import asyncio

import pytest

from app.resources.dataset_pool import DatasetPool


class FakeHandle:
    def __init__(self, key: str) -> None:
        self.key = key
        self.closed = False


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def make_pool(max_open: int = 2, idle_ttl: float = 60.0):
    opened: list[str] = []
    closed: list[str] = []

    def factory(key: str) -> FakeHandle:
        opened.append(key)
        return FakeHandle(key)

    def closer(handle: FakeHandle) -> None:
        handle.closed = True
        closed.append(handle.key)

    clock = FakeClock()
    pool = DatasetPool(
        factory=factory, closer=closer, max_open=max_open, idle_ttl=idle_ttl, clock=clock
    )
    return pool, opened, closed, clock


async def test_first_acquire_opens_and_second_reuses() -> None:
    pool, opened, _closed, _clock = make_pool()
    async with pool.acquire("a") as handle:
        assert handle.key == "a"
    async with pool.acquire("a") as handle_again:
        assert handle_again is handle
    assert opened == ["a"]
    assert pool.stats().hits == 1
    assert pool.stats().misses == 1


async def test_exceeding_max_open_evicts_the_least_recently_used() -> None:
    pool, _opened, closed, _clock = make_pool(max_open=2)
    async with pool.acquire("a"):
        pass
    async with pool.acquire("b"):
        pass
    async with pool.acquire("a"):  # touches 'a', so 'b' is now the LRU
        pass
    async with pool.acquire("c"):
        pass
    assert closed == ["b"]
    assert pool.stats().open_handles == 2
    assert set(pool.stats().keys) == {"a", "c"}
    assert pool.stats().evictions == 1


async def test_a_handle_in_use_is_never_closed_by_eviction() -> None:
    pool, _opened, closed, _clock = make_pool(max_open=1)

    async def hold() -> None:
        async with pool.acquire("held"):
            await asyncio.sleep(0.05)

    holder = asyncio.create_task(hold())
    await asyncio.sleep(0.01)
    async with pool.acquire("other"):
        pass
    await holder
    assert "held" not in closed or closed.index("held") > 0


async def test_acquire_is_exclusive_per_key() -> None:
    pool, _opened, _closed, _clock = make_pool()
    order: list[str] = []

    async def worker(tag: str) -> None:
        async with pool.acquire("shared"):
            order.append(f"enter-{tag}")
            await asyncio.sleep(0.02)
            order.append(f"exit-{tag}")

    await asyncio.gather(worker("1"), worker("2"))
    # Never interleaved: each enter is immediately followed by its own exit.
    assert order[0].startswith("enter")
    assert order[1] == order[0].replace("enter", "exit")


async def test_different_keys_do_not_block_each_other() -> None:
    pool, _opened, _closed, _clock = make_pool(max_open=4)
    started = asyncio.Event()
    release_slow = asyncio.Event()

    async def slow() -> None:
        async with pool.acquire("slow"):
            started.set()
            await release_slow.wait()

    async def fast() -> None:
        async with pool.acquire("fast") as handle:  # must not wait for 'slow'
            assert handle.key == "fast"

    task = asyncio.create_task(slow())
    await started.wait()
    # 'slow' is holding its lock indefinitely (until we set release_slow
    # below). If 'fast' were blocked on it -- e.g. a shared lock instead of
    # one per key -- this hangs rather than merely runs slow, so a
    # regression fails as an unambiguous timeout instead of a timing margin.
    await asyncio.wait_for(fast(), timeout=1.0)
    release_slow.set()
    await task


async def test_idle_handles_are_evicted_after_the_ttl() -> None:
    pool, _opened, closed, clock = make_pool(max_open=8, idle_ttl=30.0)
    async with pool.acquire("a"):
        pass
    clock.advance(10)
    assert await pool.evict_idle() == 0
    clock.advance(25)
    assert await pool.evict_idle() == 1
    assert closed == ["a"]
    assert pool.stats().open_handles == 0


async def test_close_all_closes_everything_and_resets_stats_keys() -> None:
    pool, _opened, closed, _clock = make_pool(max_open=4)
    for key in ("a", "b", "c"):
        async with pool.acquire(key):
            pass
    await pool.close_all()
    assert sorted(closed) == ["a", "b", "c"]
    assert pool.stats().open_handles == 0
    assert pool.stats().keys == []


async def test_a_failing_factory_does_not_leave_a_ghost_entry() -> None:
    def factory(key: str) -> FakeHandle:
        raise OSError("cannot open")

    pool = DatasetPool(factory=factory, closer=lambda handle: None, max_open=2, idle_ttl=60.0)
    with pytest.raises(OSError):
        async with pool.acquire("broken"):
            pass
    assert pool.stats().open_handles == 0
    assert pool.stats().keys == []
