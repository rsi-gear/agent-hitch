"""Executed only inside the explicit import worker, never by validate/plan."""
import argparse
import json
from pathlib import Path
from automationbench.domains import get_domain_dataset, PUBLIC_DOMAINS
from official import initialize, tools_for

parser = argparse.ArgumentParser()
parser.add_argument("--task", action="append", default=[])
parser.add_argument("--out", required=True)
args = parser.parse_args()
rows = []
domains = sorted({task.split(".")[0] for task in args.task}) if args.task else PUBLIC_DOMAINS
for domain in domains:
    if domain not in PUBLIC_DOMAINS:
        raise ValueError("only formal public domains are supported; simple is a separate track")
    for row in get_domain_dataset(domain):
        info = json.loads(row["info"]) if isinstance(row["info"], str) else row["info"]
        name = info["task_name"]
        if not args.task or name in args.task:
            env, state = initialize(row)
            rows.append({"id": name, "row": row, "tools": tools_for(env), "contract_sha256": state["_task_contract_sha256"]})
if args.task and set(args.task) != {r["id"] for r in rows}:
    raise ValueError("requested task IDs were not found")
Path(args.out).write_text(json.dumps(rows, ensure_ascii=False))
print(json.dumps({"task_ids": [r["id"] for r in rows]}))
