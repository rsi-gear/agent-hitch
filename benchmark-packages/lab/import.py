#!/usr/bin/env python3
"""Convert commit-pinned Harvey LAB tasks into terminal Package v1 tasks.

Uses git-tree membership, the original task JSON, and byte-identical official
lab_core evaluation code. Python >=3.9; no external importer dependencies.
"""
import argparse
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from producer_support import PYTHON_IMAGE, checkout, copy_git_tree, definitions, digest, file_records, json_file, select, task_extension, toml_text, write_package

UPSTREAM_REVISION = "e9b1f9f4dc25576f9a020d857e3e3a6420834dc3"


def flat_id(name):
    slug = re.sub(r"[^A-Za-z0-9_.-]", "-", name.replace("/", "--"))[:48].rstrip(".-")
    return "lab-" + slug + "-" + digest(name.encode())[7:23]


def produce(args):
    source = checkout(args.source, args.revision)
    listing = subprocess.check_output(["git", "-C", str(source), "ls-tree", "-rz", "--name-only", args.revision, "tasks"])
    names = [name.decode("utf-8") for name in listing.split(b"\0") if name]
    population = [PurePosixPath(name).parent.relative_to("tasks").as_posix() for name in names if name.endswith("/task.json") and len(PurePosixPath(name).parts) >= 4]
    if len({flat_id(name) for name in population}) != len(population): raise ValueError("flattened task ID collision")
    selection = select(population, args.seed, args.count, args.task)
    selection["population_scope"] = "complete-git-tree-task-json-membership"
    pure = definitions(source / "lab_core/evaluation/run_eval.py", functions=["validate_task_config"], constants=["REQUIRED_TASK_KEYS", "REQUIRED_CRITERION_KEYS", "JUDGE_MODELS"])
    judges = args.judges or list(pure["JUDGE_MODELS"])
    if not 1 <= len(judges) <= 2 or len(set(judges)) != len(judges): raise ValueError("choose one or two distinct judge models")
    detect = definitions(source / "lab_core/evaluation/judge.py", functions=["_detect_provider"])["_detect_provider"]
    if args.judge_api != "upstream" and len(judges) != 1: raise ValueError("Chat Completions transport requires exactly one judge")
    if args.judge_reasoning_effort is not None and args.judge_api == "upstream": raise ValueError("judge reasoning override requires explicit Chat Completions transport")
    for model in judges:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", model): raise ValueError("unsupported judge model ID")
        if args.judge_api == "upstream": detect(model)
    if args.parallel < 1 or args.agent_timeout < 1: raise ValueError("parallelism and agent timeout must be positive")
    root = Path(args.out).resolve(); root.mkdir(parents=True, exist_ok=False)
    json_file(root / "source-manifest.json", {"status": "importing", "selection": selection})
    tasks, transforms, ids = [], [], []
    for name in selection["tasks"]:
        raw = source / "tasks" / name
        config_path = raw / "task.json"
        if config_path.is_symlink() or not config_path.is_file(): raise ValueError("selected task.json is not materialized; expand the sparse checkout")
        original = config_path.read_bytes(); config = json.loads(original)
        pure["validate_task_config"](config, config_path)
        instructions = config.get("instructions")
        instruction_source = "task.json#instructions"
        if not instructions:
            fallback = raw / "instructions.md"
            if fallback.is_symlink() or not fallback.is_file(): raise ValueError("missing fallback instructions.md")
            instructions = fallback.read_text(encoding="utf-8"); instruction_source = "instructions.md"
        if not isinstance(instructions, str) or not instructions.strip(): raise ValueError("task instructions must be nonempty text")
        docs_relative = config.get("docs_dir") or "documents"
        if not isinstance(docs_relative, str) or PurePosixPath(docs_relative).is_absolute() or "\\" in docs_relative:
            raise ValueError("invalid docs_dir")
        # Shared corpus paths such as ../../dms are allowed inside the repository.
        docs_unresolved = raw / docs_relative
        for component in [docs_unresolved, *docs_unresolved.parents]:
            if component == source.parent: break
            if component.is_symlink(): raise ValueError("docs_dir traverses a symlink")
        documents = docs_unresolved.resolve()
        if not documents.is_relative_to(source): raise ValueError("docs_dir escapes the source repository")
        task_id = flat_id(name); ids.append(task_id)
        task = root / "tasks" / task_id; env = task / "environment"; tests = task / "tests"
        env.mkdir(parents=True); tests.mkdir()
        copy_git_tree(source, documents, env / "documents")
        # Only public parser tooling enters the candidate build context, never lab_core/task.json.
        sandbox = source / "lab_core/sandbox"
        for filename in ["Dockerfile", "install_pandoc.sh"]: shutil.copy2(sandbox / filename, env / filename)
        copy_git_tree(source, sandbox / "parsers", env / "parsers")
        original_docker = (env / "Dockerfile").read_text(encoding="utf-8")
        docker, replaced = re.subn(r"^FROM\s+\S+", "FROM " + PYTHON_IMAGE, original_docker, flags=re.M)
        if replaced != 1: raise ValueError("unsupported upstream candidate Dockerfile")
        docker += "\nCOPY documents/ /workspace/documents/\nRUN chmod -R a-w /workspace/documents && mkdir -p /workspace/output\n"
        (env / "Dockerfile").write_text(docker, encoding="utf-8")
        before = root / "source-files" / task_id / "Dockerfile"; before.parent.mkdir(parents=True); before.write_text(original_docker, encoding="utf-8")
        (task / "source-instructions.txt").write_text(instructions, encoding="utf-8")
        (task / "instruction.md").write_text(instructions + "\n\nInput documents are under /workspace/documents. Save final deliverables under /workspace/output with the filenames requested above. The selected Hitch terminal harness has public network access.\n", encoding="utf-8")
        transforms.extend([{"kind": "pin-candidate-base-and-copy-public-documents", "before_path": before.relative_to(root).as_posix(), "after_path": (env / "Dockerfile").relative_to(root).as_posix()},
            {"kind": "declare-terminal-input-output-and-network", "before_path": (task / "source-instructions.txt").relative_to(root).as_posix(), "after_path": (task / "instruction.md").relative_to(root).as_posix()}])
        grading_task = tests / "lab/tasks" / name; grading_task.mkdir(parents=True)
        (grading_task / "task.json").write_bytes(original)
        # No normalization or rewriting of criteria, deliverables, weights or evaluation options.
        vendor = tests / "vendor"; vendor.mkdir()
        copy_git_tree(source, source / "lab_core", vendor / "lab_core")
        # This unused source recipe is provenance, not a build recipe in the verifier.
        (vendor / "lab_core/sandbox/Dockerfile").rename(vendor / "lab_core/sandbox/upstream-sandbox-dockerfile.txt")
        for filename in ["pyproject.toml", "uv.lock", "README.md", "LICENSE"]: shutil.copy2(source / filename, vendor / filename)
        shutil.copy2(sandbox / "install_pandoc.sh", tests / "install_pandoc.sh")
        for file in Path(__file__).with_name("runtime").glob("*.py"): shutil.copy2(file, tests / file.name)
        json_file(tests / "judge.json", {"protocol": "harvey-lab-official@1", "source_task_id": name, "source_revision": args.revision,
            "models": judges, "api": args.judge_api, "reasoning_effort": args.judge_reasoning_effort, "parallel": args.parallel, "primary": "dual_all_pass_rate" if len(judges) == 2 else "score",
            "matching_model": "claude-sonnet-4-6 (official fallback matcher)", "network": "public"})
        extra = " --extra mistral" if args.judge_api == "upstream" and any(detect(m) == "mistral" for m in judges) else ""
        (tests / "Dockerfile").write_text(f'''FROM {PYTHON_IMAGE}
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.12.3
COPY vendor/ /opt/lab/
RUN cd /opt/lab && UV_PYTHON_DOWNLOADS=never uv sync --frozen --no-dev --no-install-project{extra}
COPY install_pandoc.sh /tmp/install_pandoc.sh
RUN sh /tmp/install_pandoc.sh && rm /tmp/install_pandoc.sh
ENV PATH="/opt/lab/.venv/bin:$PATH" PYTHONPATH="/opt/lab" LAB_ROOT="/tests/lab"
COPY . /tests/
RUN mkdir -p /workspace/output /logs/verifier
WORKDIR /tests
CMD ["sleep", "infinity"]
''', encoding="utf-8")
        (tests / "test.sh").write_text("#!/bin/sh\nset -eu\nexec python /tests/hitch_grade.py\n", encoding="utf-8")
        credentials = {f"{provider}_API_KEY": "${HITCH_LAB_JUDGE_" + provider + "_API_KEY:-}" for provider in ["ANTHROPIC", "OPENAI", "GOOGLE", "MISTRAL"]}
        credentials.update({"OPENAI_BASE_URL": "${HITCH_LAB_JUDGE_OPENAI_BASE_URL:-https://api.openai.com/v1}", "ANTHROPIC_BASE_URL": "${HITCH_LAB_JUDGE_ANTHROPIC_BASE_URL:-https://api.anthropic.com}"})
        (task / "task.toml").write_text(toml_text({"schema_version": "1.4", "artifacts": ["/workspace/output"],
            "metadata": {"category": "legal", "source_task_id": name}, "agent": {"timeout_sec": args.agent_timeout},
            "environment": {"cpus": 2, "memory_mb": 4096, "storage_mb": 20480, "build_timeout_sec": 1800, "workdir": "/workspace", "network_mode": "public"},
            "verifier": {"timeout_sec": 7200, "environment_mode": "separate", "env": credentials,
                "environment": {"cpus": 2, "memory_mb": 4096, "storage_mb": 10240, "build_timeout_sec": 1800, "network_mode": "public", "workdir": "/tests"}}}), encoding="utf-8")
        task_extension(task, name, "/workspace/output", ["lab_all_pass", "lab_criterion_pass"])
        tasks.append({"task_id": task_id, "source_task_id": name, "task_json_sha256": digest(original), "instruction_source": instruction_source,
            "documents_source": documents.relative_to(source).as_posix(), "documents": file_records(env / "documents"), "generated_files": file_records(task)})
    shutil.copy2(__file__, root / "source-adapter.py")
    shutil.copy2(Path(__file__).resolve().parents[1] / "producer_support.py", root / "source-support.py")
    shutil.copy2(source / "LICENSE", root / "UPSTREAM-LICENSE")
    json_file(root / "source-manifest.json", {"schema_version": "1", "status": "ready", "source": "https://github.com/harveyai/harvey-labs", "source_revision": args.revision,
        "selection": selection, "tasks": tasks, "transformations": transforms, "adapter": {"id": "harvey-lab", "version": "1", "path": "source-adapter.py"},
        "judge_transport": {"api": args.judge_api, "models": judges, "reasoning_effort": args.judge_reasoning_effort},
        "scoring": "official single all-pass score / dual_all_pass_rate; criterion pass fraction auxiliary only",
        "execution_profile": "Hitch terminal harness, open candidate network; differs from official LAB reference harness with network=none",
        "dependency_policy": "verifier uv.lock frozen; upstream candidate apt/pip/npm remain as authored, image build receipts identify resolved image",
        "matching_failure_policy": "official Anthropic matcher retained; swallowed LLM matching failure is promoted to invalid verification"})
    package_selection = {**selection, "tasks": ids}
    write_package(root, name="harvey-lab-" + ("dual" if len(judges) == 2 else "single"), revision=args.revision,
        uri="https://github.com/harveyai/harvey-labs", license="MIT", selection=package_selection, primary="lab_all_pass",
        metrics={"lab_all_pass": "scalar" if len(judges) == 2 else "binary", "lab_criterion_pass": "scalar"},
        extensions={"judge_models": judges, "judge_api": args.judge_api, "judge_reasoning_effort": args.judge_reasoning_effort, "source_selection": selection, "network_difference": "open-network Hitch harness; not reference LAB harness parity",
        "credential_policy": "host HITCH_LAB_JUDGE_* variables resolve only in verifier; never --pass-env", "auxiliary_metrics": ["lab_criterion_pass"]})
    return {"package": str(root), "selection": selection, "task_ids": ids, "judges": judges}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True); parser.add_argument("--revision", default=UPSTREAM_REVISION)
    parser.add_argument("--seed", type=int, default=0); parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--task", action="append", help="original nested task ID; repeatable")
    parser.add_argument("--judges", nargs="+", help="one or two judge models; default is read from pinned official code")
    parser.add_argument("--judge-api", choices=["upstream", "openai-chat-completions"], default="upstream", help="explicit single-judge transport; upstream keeps official provider detection")
    parser.add_argument("--judge-reasoning-effort", choices=["none", "low", "medium", "high", "xhigh", "max"], help="optional Chat Completions reasoning_effort")
    parser.add_argument("--parallel", type=int, default=6); parser.add_argument("--agent-timeout", type=int, default=7200)
    parser.add_argument("--out", required=True)
    print(json.dumps(produce(parser.parse_args()), indent=2))
