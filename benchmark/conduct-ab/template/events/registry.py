"""Event registry for a medieval strategy game.

An Event is a titled chain of exactly the outcomes a mission writes for it.
Modules register their event at import time; tests import the module and
read it back with `get`.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class Outcome:
    id: str
    chronicle: str
    effects: dict


@dataclass(frozen=True)
class Event:
    id: str
    title: str
    outcomes: tuple


_EVENTS: dict = {}


def register(event: Event) -> Event:
    """Register an event under its id. A second event with the same id is an error."""
    if event.id in _EVENTS:
        raise ValueError(f"event {event.id!r} is already registered")
    _EVENTS[event.id] = event
    return event


def get(event_id: str) -> Event:
    """The registered event, or KeyError."""
    return _EVENTS[event_id]


def all_events() -> list:
    return list(_EVENTS.values())
