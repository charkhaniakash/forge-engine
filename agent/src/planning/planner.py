"""
Planner Protocol — the interface every planner implementation must satisfy.

Phase 5 ships ImplementationPlanner.
Future planners (BugFixPlanner, MigrationPlanner, etc.) implement this
protocol and register themselves in the PlannerRegistry without touching
any other module.

The protocol is typed by the structure of the plan it produces, not by
the user's intent category. The plan_type field on the PlanBody distinguishes
what kind of execution contract the executor should expect.
"""
from __future__ import annotations

from typing import AsyncIterator, Protocol, runtime_checkable

from src.core.models import AssembledContext
from src.planning.models import PlanBody, PlanningRequest


@runtime_checkable
class Planner(Protocol):
    """Contract for all planning implementations.

    generate() is an async generator that:
      1. Yields intermediate reasoning strings (displayed in the UI during generation).
      2. Finally yields the completed PlanBody as the last item.

    The pipeline wraps this in try/except and handles all NDJSON emission.
    The planner never emits NDJSON directly — it only yields reasoning strings
    and returns a PlanBody.
    """

    @property
    def plan_type(self) -> str:
        """The plan_type string stored in plans.plan_type. e.g. 'implementation'."""
        ...

    @property
    def planner_id(self) -> str:
        """Unique identifier for this planner version. e.g. 'implementation_planner_v1'."""
        ...

    async def generate(
        self,
        req: PlanningRequest,
        context: AssembledContext,
        prior_plan: PlanBody | None,
    ) -> AsyncIterator[str | PlanBody]:
        """Generate a plan.

        Yields:
          str      — intermediate reasoning message for UI progress display
          PlanBody — exactly once, as the final yielded item

        The pipeline reads the generator until it receives a PlanBody, then stops.
        """
        ...
