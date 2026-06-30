"""
PlannerRegistry — maps planner_hint strings to Planner implementations.

Phase 5 registers only ImplementationPlanner.
Adding a new planner:
  1. Implement the Planner protocol in a new module.
  2. Add one line to _REGISTRY below.
  3. Nothing else changes.

The intent classifier (intent_classifier.py) is also called here to resolve
an unrecognised hint to a default — currently a stub that always returns
"implementation".
"""
from __future__ import annotations

import structlog

from src.planning.planner import Planner

logger = structlog.get_logger()

# Registry populated at import time. Lazy imports avoid loading unused modules.
_REGISTRY: dict[str, type] = {}


def _populate() -> None:
    from src.planning.implementation_planner import ImplementationPlanner
    _REGISTRY["implementation"] = ImplementationPlanner


def get_planner(hint: str) -> Planner:
    """Return a Planner instance for the given hint string.

    Falls back to 'implementation' for unknown hints (stub classifier behaviour).
    """
    if not _REGISTRY:
        _populate()

    key = hint.lower().strip()
    planner_cls = _REGISTRY.get(key)

    if planner_cls is None:
        logger.warning(
            "unknown_planner_hint",
            hint=hint,
            fallback="implementation",
        )
        planner_cls = _REGISTRY["implementation"]

    return planner_cls()
