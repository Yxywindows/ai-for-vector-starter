import asyncio
import threading

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


async def test_a_slow_factory_for_one_key_does_not_block_a_different_key() -> None:
    """Step 4b: `_checkout` must not hold `self._guard` while the factory
    runs -- `Reader(path)` does real file I/O (header, tiling scheme,
    overview table), and the placeholder factory Task 11 tested against
    returned instantly, so it could never have caught the guard being held
    across a slow open. Unlike `test_different_keys_do_not_block_each_other`
    above, the factory here blocks on a real `threading.Event` inside the
    worker thread `_checkout`'s dedicated `ThreadPoolExecutor` runs it on --
    not an `asyncio.Event` the event loop could interleave around for free
    -- so a regression that reintroduces the guard around the factory call
    makes 'fast' hang waiting for the event loop itself, not just for a
    lock.
    """
    loop = asyncio.get_running_loop()
    entered_slow_open = asyncio.Event()
    release_slow_open = threading.Event()

    def factory(key: str) -> FakeHandle:
        if key == "slow":
            loop.call_soon_threadsafe(entered_slow_open.set)
            assert release_slow_open.wait(timeout=5), "test deadlocked: never released"
        return FakeHandle(key)

    pool = DatasetPool(factory=factory, closer=lambda handle: None, max_open=4, idle_ttl=60.0)

    async def slow() -> None:
        async with pool.acquire("slow"):
            pass

    async def fast() -> None:
        async with pool.acquire("fast") as handle:
            assert handle.key == "fast"

    task = asyncio.create_task(slow())
    await asyncio.wait_for(entered_slow_open.wait(), timeout=1.0)
    await asyncio.wait_for(fast(), timeout=1.0)
    release_slow_open.set()
    await task


async def test_concurrent_checkouts_of_the_same_key_close_the_racing_loser() -> None:
    """Releasing `self._guard` around the factory call (Step 4b) opens a new
    race that never existed before: two coroutines can both miss the same
    key while the guard is up for grabs, and both open a handle. Exactly one
    may end up live in the pool; the other must be closed through
    `self._closer`, not leaked open and unreferenced. A `threading.Barrier`
    forces both factory calls to be genuinely in flight at once -- on real
    worker threads -- before either returns, so the race is deterministic
    rather than a timing gamble.
    """
    barrier = threading.Barrier(2, timeout=5)

    def factory(key: str) -> FakeHandle:
        barrier.wait()  # both callers must be mid-open before either returns
        return FakeHandle(key)

    closed: list[FakeHandle] = []

    def closer(handle: FakeHandle) -> None:
        handle.closed = True
        closed.append(handle)

    pool = DatasetPool(factory=factory, closer=closer, max_open=4, idle_ttl=60.0)
    handles: list[FakeHandle] = []

    async def checkout() -> None:
        async with pool.acquire("shared") as handle:
            handles.append(handle)

    await asyncio.wait_for(asyncio.gather(checkout(), checkout()), timeout=5.0)

    assert pool.stats().open_handles == 1
    assert handles[0] is handles[1]  # both callers ended up with the survivor
    assert len(closed) == 1
    assert closed[0] is not handles[0]  # the loser was closed, not the winner


async def test_a_cancelled_checkout_during_the_open_leaves_no_leak() -> None:
    """`asyncio.CancelledError` derives from `BaseException`, not
    `Exception` -- Step 4b's two new `await` points between the factory
    call and its handle being committed to `self._entries` are cancellable
    in a way the Task 11 placeholder's single, yield-free span never was.
    A checkout cancelled while its factory is still running on a worker
    thread must not abandon whatever that factory eventually produces:
    the handle must still be closed, and its dedicated thread must still
    exit -- neither is optional just because nobody is left waiting for
    the checkout that started them.
    """
    baseline_threads = threading.active_count()
    entered_factory = threading.Event()
    release_factory = threading.Event()
    closed: list[FakeHandle] = []

    def factory(key: str) -> FakeHandle:
        entered_factory.set()
        assert release_factory.wait(timeout=5), "test deadlocked: never released"
        return FakeHandle(key)

    def closer(handle: FakeHandle) -> None:
        handle.closed = True
        closed.append(handle)

    pool = DatasetPool(factory=factory, closer=closer, max_open=4, idle_ttl=60.0)

    async def checkout() -> None:
        async with pool.acquire("cancel-me"):
            pass  # never reached -- the task is cancelled before this

    task = asyncio.create_task(checkout())
    # Wait for the factory to actually start on its own worker thread --
    # not merely for the task to be scheduled -- so a `concurrent.futures.
    # Future` already RUNNING is what gets cancelled against, exactly the
    # window a naive `except Exception:` cannot catch. Polling `is_set()`
    # rather than `run_in_executor(None, entered_factory.wait, ...)`
    # deliberately avoids waking the loop's own default executor: that
    # would spin up a worker thread of its own, which lingers afterwards
    # and would corrupt the `threading.active_count()` comparison below.
    for _ in range(500):
        if entered_factory.is_set():
            break
        await asyncio.sleep(0.01)
    assert entered_factory.is_set(), "test deadlocked: factory never started"

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # The factory is still blocked on `release_factory` at this point --
    # cancelling `task` cannot stop a thread already running it. Let it
    # finish and give the pool's own background cleanup a bounded window
    # to close the handle it produces and retire its thread.
    release_factory.set()
    for _ in range(300):
        if closed and threading.active_count() == baseline_threads:
            break
        await asyncio.sleep(0.01)

    assert closed and closed[0].key == "cancel-me"  # the leaked handle was closed
    assert threading.active_count() == baseline_threads  # its thread exited
    assert pool.stats().open_handles == 0  # no ghost entry
    assert pool.stats().keys == []


async def test_a_cancelled_checkout_does_not_permanently_pin_the_entry_it_committed() -> None:
    """A second cancellation window, distinct from the one above: once a
    new entry is inserted into `self._entries` (`in_use=1`), the only
    remaining await before `_checkout` returns it is `_enforce_capacity`,
    which only truly suspends when it has something to evict. Force that
    by filling the pool to `max_open` first, then checking out one more
    key while the eviction its insertion triggers is blocked on a slow
    close, and cancel while that eviction is in flight. If the claim on
    the *new* entry were left at `in_use=1` forever, nothing would ever
    release it -- `acquire`'s own `finally` never runs, because
    `_checkout` itself never returns the entry to bind -- permanently
    shrinking the pool's effective capacity by one.
    """
    entered_close = threading.Event()
    release_close = threading.Event()

    def factory(key: str) -> FakeHandle:
        return FakeHandle(key)

    def closer(handle: FakeHandle) -> None:
        entered_close.set()
        assert release_close.wait(timeout=5), "test deadlocked: never released"
        handle.closed = True

    clock = FakeClock()
    pool = DatasetPool(factory=factory, closer=closer, max_open=1, idle_ttl=30.0, clock=clock)

    async with pool.acquire("a"):
        pass  # 'a' is now idle, the pool's only entry, already at capacity

    async def checkout_b() -> None:
        async with pool.acquire("b"):
            pass  # never reached

    task = asyncio.create_task(checkout_b())
    # Opening 'b' is instant; committing it pushes the pool over
    # max_open=1, so `_enforce_capacity` must evict 'a' -- that eviction's
    # close is what blocks here, with 'b' already inserted at `in_use=1`.
    for _ in range(500):
        if entered_close.is_set():
            break
        await asyncio.sleep(0.01)
    assert entered_close.is_set(), "test deadlocked: eviction of 'a' never started"

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    release_close.set()

    for _ in range(300):
        if pool.stats().open_handles <= 1:
            break
        await asyncio.sleep(0.01)
    assert pool.stats().open_handles == 1  # 'a' evicted, 'b' remains

    # A stuck `in_use` count is invisible to `stats()` and even to a fresh
    # `acquire("b")` -- a hit still reuses the entry and still returns the
    # right handle regardless of whether its claim was ever released. The
    # one place a permanent pin is observable from outside is eviction:
    # `evict_idle`/`_enforce_capacity` both skip any entry with
    # `in_use > 0`, forever, no matter how stale it is. Advancing well
    # past `idle_ttl` and evicting is the black-box proof the claim this
    # cancelled checkout took out on 'b' was actually released.
    clock.advance(60.0)
    assert await pool.evict_idle() == 1
    assert pool.stats().open_handles == 0


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
