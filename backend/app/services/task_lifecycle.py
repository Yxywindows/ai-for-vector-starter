"""The task state machine, separated from every handler.

One place defines what may follow what; services assert against it before
writing, so an invalid transition is a 409 at the boundary instead of a
corrupted history row.
"""

from __future__ import annotations

from app.core.errors import ConflictError

TERMINAL_STATES = frozenset({"succeeded", "failed", "cancelled"})

# state -> the states that may legally follow it
TRANSITIONS: dict[str, frozenset[str]] = {
    "queued": frozenset({"running", "cancelled"}),
    "running": frozenset({"succeeded", "failed", "cancelling"}),
    # Work may complete, fail, or notice the flag after cancel was asked:
    # all three are legitimate ends of a cancelling task.
    "cancelling": frozenset({"cancelled", "failed", "succeeded"}),
    "succeeded": frozenset(),
    "failed": frozenset(),
    "cancelled": frozenset(),
}


def is_terminal(state: str) -> bool:
    return state in TERMINAL_STATES


def can_transition(current: str, target: str) -> bool:
    return target in TRANSITIONS.get(current, frozenset())


def assert_transition(current: str, target: str) -> None:
    if not can_transition(current, target):
        raise ConflictError(
            f"A {current} task cannot become {target}",
            details={"from": current, "to": target, "allowed": sorted(TRANSITIONS[current])},
        )
