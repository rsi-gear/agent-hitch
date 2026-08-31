"""Behavioral smoke test for Harbor model-proxy routing."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
from pathlib import Path
from typing import Any


class BaseAgent:
    def __init__(self, logs_dir: Path, **kwargs: Any) -> None:
        self.logs_dir = Path(logs_dir)
        self.model_name = kwargs.get("model_name")


class BaseEnvironment:
    pass


class ExecResult:
    def __init__(self, return_code: int) -> None:
        self.return_code = return_code
        self.stdout = ""
        self.stderr = ""


class AgentContext:
    pass


class Environment(BaseEnvironment):
    def __init__(self, return_code: int) -> None:
        self.return_code = return_code
        self.commands: list[str] = []

    async def exec(self, command: str, **_kwargs: Any) -> ExecResult:
        self.commands.append(command)
        return ExecResult(self.return_code)


def load_bridge(source: Path):
    harbor = types.ModuleType("harbor")
    agents = types.ModuleType("harbor.agents")
    agents_base = types.ModuleType("harbor.agents.base")
    agents_base.BaseAgent = BaseAgent
    environments = types.ModuleType("harbor.environments")
    environments_base = types.ModuleType("harbor.environments.base")
    environments_base.BaseEnvironment = BaseEnvironment
    environments_base.ExecResult = ExecResult
    models = types.ModuleType("harbor.models")
    model_agent = types.ModuleType("harbor.models.agent")
    context = types.ModuleType("harbor.models.agent.context")
    context.AgentContext = AgentContext
    sys.modules.update({
        "harbor": harbor,
        "harbor.agents": agents,
        "harbor.agents.base": agents_base,
        "harbor.environments": environments,
        "harbor.environments.base": environments_base,
        "harbor.models": models,
        "harbor.models.agent": model_agent,
        "harbor.models.agent.context": context,
    })
    spec = importlib.util.spec_from_file_location("hitch_harbor_agent", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def main(source: Path, logs: Path) -> None:
    module = load_bridge(source)
    route = {
        "schema_version": "1",
        "mode": "hybrid",
        "required": True,
        "topology": "host-side",
        "base_url_template": "http://host.docker.internal:4321/cap/{run_id}/{provider}",
        "health_url_template": "http://host.docker.internal:4321/cap/{run_id}/health",
    }
    agent = module.HitchHarborAgent(
        logs_dir=logs,
        harness_ref="pi@version:1.2.3",
        revision_identity="sha256:" + "a" * 64,
        hitch_runtime_dir=str(logs),
        model_capture=route,
    )
    run_id = "run_" + "b" * 32
    healthy = Environment(0)
    variables, status = await agent._model_proxy_environment(healthy, run_id)
    assert status == "healthy"
    assert variables == [
        f"OPENAI_BASE_URL=http://host.docker.internal:4321/cap/{run_id}/openai",
        f"ANTHROPIC_BASE_URL=http://host.docker.internal:4321/cap/{run_id}/anthropic",
    ]
    assert run_id in healthy.commands[0]
    try:
        await agent._model_proxy_environment(Environment(1), run_id)
    except RuntimeError as error:
        assert "hitch-model-proxy-health" in str(error)
    else:
        raise AssertionError("required model proxy health failure was accepted")
    optional = module.HitchHarborAgent(
        logs_dir=logs,
        harness_ref="pi@version:1.2.3",
        revision_identity="sha256:" + "a" * 64,
        hitch_runtime_dir=str(logs),
        model_capture={**route, "required": False},
    )
    assert await optional._model_proxy_environment(Environment(1), run_id) == ([], "degraded-unreachable")
    try:
        module._validate_model_capture({**route, "unexpected": True})
    except ValueError:
        pass
    else:
        raise AssertionError("unknown model capture field was accepted")
    print("model proxy bridge smoke OK")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1]), Path(sys.argv[2])))
