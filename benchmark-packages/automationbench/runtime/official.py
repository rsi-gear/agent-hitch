"""Thin bindings to the pinned upstream environment. No business rules here."""
import asyncio
import json
from pathlib import Path

from datasets import Dataset
from automationbench.runner import AutomationBenchEnv
from automationbench.rubric import create_rubric, partial_credit, task_completed_correctly
from automationbench.schema.world import WorldState
from automationbench.tools.api import API_TOOLS
from score_contract import process_evidence


def initialize(row):
    env = AutomationBenchEnv(dataset=Dataset.from_list([row]), rubric=create_rubric(), toolset="api")
    state = asyncio.run(env.setup_state(dict(row)))
    return env, state


def tools_for(env):
    return [{"name": item["function"]["name"], "description": item["function"]["description"], "inputSchema": item["function"]["parameters"]} for item in env._all_oai_tools]


def call(env, state, name, arguments):
    tools = {tool.__name__: tool for tool in API_TOOLS}
    args = env.update_tool_args(name, arguments, [], state)
    return tools[name](**args)


def grade(task_path, snapshot_path, output_dir):
    row = json.loads(Path(task_path).read_text())
    env, state = initialize(row)
    snapshot = json.loads(Path(snapshot_path).read_text())
    if snapshot["task_contract_sha256"] != state["_task_contract_sha256"] or snapshot["sealed"] is not True:
        raise ValueError("snapshot does not match the task contract")
    state["world"] = WorldState(**snapshot["world"])
    partial = partial_credit(state)
    strict = task_completed_correctly(state)
    output = Path(output_dir); output.mkdir(parents=True, exist_ok=True)
    (output / "assertions.json").write_text(json.dumps(state["_assertion_results"], indent=2))
    process = process_evidence(state["_assertion_results"], partial)
    (output / "process.json").write_text(json.dumps(process, indent=2))
    (output / "reward.json").write_text(json.dumps({
        "reward": strict,
        "total_score": strict,
        "process_score": partial,
    }, indent=2))


if __name__ == "__main__":
    import sys
    try:
        grade(*sys.argv[1:])
    except Exception as error:
        output = Path(sys.argv[-1]); output.mkdir(parents=True, exist_ok=True)
        (output / "grader-error.json").write_text(json.dumps({"code": "official_grader_failed", "message": str(error)}))
        raise
