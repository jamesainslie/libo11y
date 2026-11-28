"""pytest plugin providing the hermetic ``o11y_recorder`` fixture.

pytest loads this module through the ``pytest11`` entry point before any
coverage measurement starts. It lives outside the ``libo11y`` package and
imports nothing from it at load time, so loading the plugin does not import
libo11y early and leave its module-level lines unmeasured. The fixture
imports the recorder when a test first requests it.
"""

from __future__ import annotations

from collections.abc import Generator
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from libo11y.testing import Recorder


@pytest.fixture
def o11y_recorder(request: pytest.FixtureRequest) -> Generator[Recorder]:
    """Yield a fresh hermetic Recorder scoped to the test and shut it down cleanly."""
    from libo11y.testing import start_recorder

    with start_recorder(service_name=request.node.name) as rec:
        yield rec
