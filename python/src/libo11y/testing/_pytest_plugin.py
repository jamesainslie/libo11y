"""pytest plugin providing the hermetic o11y_recorder fixture."""

from __future__ import annotations

from collections.abc import Generator
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from libo11y.testing.recorder import Recorder


@pytest.fixture
def o11y_recorder(request: pytest.FixtureRequest) -> Generator[Recorder]:
    """Yield a fresh hermetic Recorder scoped to the test and shut it down cleanly."""
    from libo11y.testing.recorder import start_recorder

    with start_recorder(service_name=request.node.name) as rec:
        yield rec
