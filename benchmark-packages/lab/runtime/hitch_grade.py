"""Artifact bridge to the official LAB evaluation functions, never an alternate rubric."""
import argparse
from contextlib import redirect_stderr, redirect_stdout
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile


def inspect_output(output):
    if output.is_symlink(): raise ValueError("unsafe output symlink")
    if not output.exists(): return
    if not output.is_dir(): raise ValueError("output must be a directory")
    total = 0
    for current, names, files in os.walk(output, followlinks=False):
        for name in [*names, *files]:
            path = Path(current) / name
            mode = path.lstat().st_mode
            if any(ord(c) < 32 for c in name) or stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise ValueError("unsafe output entry")
            if stat.S_ISREG(mode): total += path.stat().st_size
            if total > 536870912: raise ValueError("output exceeds artifact limit")


def validate_single(scores, criterion_ids):
    results = scores.get("criteria_results")
    if not isinstance(results, list) or len(results) != len(criterion_ids) or [c.get("id") for c in results] != criterion_ids:
        raise ValueError("LAB criterion membership mismatch")
    if scores.get("n_grading_errors") != 0 or any(c.get("verdict") not in ("pass", "fail") for c in results):
        raise ValueError("LAB judge could not grade every criterion")
    n_passed = sum(c["verdict"] == "pass" for c in results)
    all_pass = n_passed == len(criterion_ids)
    if scores.get("n_criteria") != len(criterion_ids) or scores.get("n_passed") != n_passed or scores.get("all_pass") is not all_pass:
        raise ValueError("LAB all-pass metadata mismatch")
    if scores.get("score") != int(all_pass) or scores.get("max_score") != 1:
        raise ValueError("LAB official all-pass score mismatch")
    return int(all_pass), n_passed / len(criterion_ids)


def normalize(scores, criterion_ids, models):
    if not criterion_ids or len(set(criterion_ids)) != len(criterion_ids): raise ValueError("invalid source criteria")
    if len(models) == 1:
        primary, auxiliary = validate_single(scores, criterion_ids)
    else:
        if scores.get("judges") != models or set(scores.get("per_judge", {})) != set(models):
            raise ValueError("LAB judge membership mismatch")
        values = [validate_single(scores["per_judge"][model], criterion_ids) for model in models]
        primary = sum(x[0] for x in values) / len(values)
        auxiliary = sum(x[1] for x in values) / len(values)
        if scores.get("dual_all_pass_rate") != primary or scores.get("dual_criterion_pass") != auxiliary:
            raise ValueError("LAB dual aggregate mismatch")
    return {"lab_all_pass": primary, "lab_criterion_pass": auxiliary}


def publish_logs(logs, destination, secrets):
    # Upstream diagnostics stay private until exact-value redaction is complete.
    # A killed verifier cannot expose a partially written raw provider exception.
    for file in logs.rglob("*"):
        if file.is_file() and not file.is_symlink():
            data = file.read_bytes()
            for value in sorted(set(secrets), key=len, reverse=True):
                if value: data = data.replace(value.encode(), b"[REDACTED]")
            target = destination / file.relative_to(logs)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)


def run(tests, output, destination):
    destination.mkdir(parents=True, exist_ok=True)
    for stale in ["reward.json", "grading-error.json", "judge-provenance.json"]:
        (destination / stale).unlink(missing_ok=True)
    for stale in destination.glob("scores*.json"): stale.unlink()
    secrets = [v for k, v in os.environ.items() if v and any(s in k.upper() for s in ("API_KEY", "TOKEN", "SECRET", "PASSWORD"))]
    with tempfile.TemporaryDirectory(prefix="lab-private-diagnostics-") as private_logs:
        logs = Path(private_logs)
        status = 1
        try:
            inspect_output(output)
            config = json.loads((tests / "judge.json").read_text(encoding="utf-8"))
            (logs / "judge-provenance.json").write_text(json.dumps(config, indent=2) + "\n")
            source_id = config["source_task_id"]
            task_config = json.loads((tests / "lab/tasks" / source_id / "task.json").read_text(encoding="utf-8"))
            models = config["models"]
            # A private writable LAB root lets upstream emit its ordinary per-judge score files.
            with tempfile.TemporaryDirectory(prefix="lab-evaluation-") as directory:
                lab = Path(directory)
                (lab / "tasks" / source_id).mkdir(parents=True)
                shutil.copy2(tests / "lab/tasks" / source_id / "task.json", lab / "tasks" / source_id / "task.json")
                run_dir = lab / "results/hitch"; run_dir.mkdir(parents=True)
                if output.exists(): shutil.copytree(output, run_dir / "output")
                else: (run_dir / "output").mkdir()
                os.environ["LAB_ROOT"] = str(lab)
                sys.path.insert(0, str(tests / "vendor"))
                with (logs / "judge-output.log").open("w", encoding="utf-8") as stream, redirect_stdout(stream), redirect_stderr(stream):
                    from lab_core.evaluation import run_eval as evaluation
                    from hitch_judge import chat_judge, cliproxy_judge, cliproxy_matcher, validated_judges
                    try:
                        with validated_judges(evaluation) as Judge:
                            api = config.get("api", "upstream")
                            if api == "openai-chat-completions":
                                if len(models) != 1: raise ValueError("Chat Completions transport requires one judge")
                                judge = chat_judge(Judge, models[0], config.get("reasoning_effort"))
                                config["transport"] = judge.transport_provenance
                                (logs / "judge-provenance.json").write_text(json.dumps(config, indent=2) + "\n")
                                scores = evaluation.evaluate_run("hitch", source_id, judge, parallel=config["parallel"])
                            elif api == "openai-responses":
                                if config.get("profile") != "cliproxy-codex" or len(models) != 1:
                                    raise ValueError("CLIProxy Responses transport requires its explicit single-judge profile")
                                from lab_core.evaluation import scoring
                                judge = cliproxy_judge(Judge, config)
                                config["transport"] = judge.transport_provenance
                                config["matching_transport"] = {**judge.client.provenance,
                                    "prompt_schema_preview_and_matching": "official _llm_match_deliverables and _match_deliverables",
                                    "official_requested_controls": {"temperature": 0.0, "max_tokens": 1024}}
                                (logs / "judge-provenance.json").write_text(json.dumps(config, indent=2) + "\n")
                                with cliproxy_matcher(scoring, judge.client):
                                    scores = evaluation.evaluate_run("hitch", source_id, judge, parallel=config["parallel"])
                            elif api != "upstream":
                                raise ValueError("unsupported LAB judge API")
                            elif len(models) == 2:
                                scores = evaluation.evaluate_run_dual("hitch", source_id, parallel=config["parallel"], judge_models=tuple(models))
                            else:
                                scores = evaluation.evaluate_run("hitch", source_id, Judge(model=models[0]), parallel=config["parallel"])
                    finally:
                        for file in run_dir.glob("scores*.json"): shutil.copy2(file, logs / file.name)
                # The official matcher catches API/parsing exceptions itself; promote its failure to invalid verification.
                if any(line.startswith("  LLM matching failed:") for line in (logs / "judge-output.log").read_text().splitlines()):
                    raise ValueError("LAB deliverable matcher failed")
                rewards = normalize(scores, [c["id"] for c in task_config["criteria"]], models)
            (logs / "reward.json").write_text(json.dumps(rewards) + "\n")
            (logs / "judge-provenance.json").write_text(json.dumps(config, indent=2) + "\n")
            status = 0
        except Exception as error:
            (logs / "reward.json").unlink(missing_ok=True)
            (logs / "grading-error.json").write_text(json.dumps({"code": "lab_grading_failed", "type": type(error).__name__, "message": str(error)}) + "\n")
        finally:
            publish_logs(logs, destination, secrets)

    return status


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tests", type=Path, default=Path("/tests")); parser.add_argument("--output", type=Path, default=Path("/workspace/output"))
    parser.add_argument("--logs", type=Path, default=Path("/logs/verifier"))
    args = parser.parse_args(); sys.exit(run(args.tests, args.output, args.logs))
