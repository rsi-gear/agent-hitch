from __future__ import annotations
import json
from pathlib import Path
from datetime import datetime, timezone
from lab_core import paths
from lab_core.evaluation.judge import Judge
from lab_core.evaluation.scoring import score_rubric
REQUIRED_TASK_KEYS = {"title", "instructions", "criteria"}

REQUIRED_CRITERION_KEYS = {"id", "title", "match_criteria"}

JUDGE_MODELS = ("claude-sonnet-4-6", "gpt-5.5")

STANDARD_DUAL_JUDGE_PROFILE = "lab-standard-dual-v1"

CUSTOM_DUAL_JUDGE_PROFILE = "custom-dual"

def validate_task_config(config: dict, task_path: Path) -> None:
    """Validate that task.json has all required fields for running and grading.

    Raises ValueError with a specific message for any missing or malformed field.
    """
    for key in REQUIRED_TASK_KEYS:
        if key not in config:
            raise ValueError(f"{task_path}: missing required key '{key}'")

    criteria = config["criteria"]
    if not isinstance(criteria, list) or not criteria:
        raise ValueError(f"{task_path}: 'criteria' must be a non-empty list")

    for i, criterion in enumerate(criteria):
        for key in REQUIRED_CRITERION_KEYS:
            if key not in criterion:
                raise ValueError(
                    f"{task_path}: criterion {i} ('{criterion.get('id', '?')}') missing required key '{key}'"
                )
        # Validate deliverables is a list of strings when present
        criterion_deliverables = criterion.get("deliverables", [])
        if criterion_deliverables and not isinstance(criterion_deliverables, list):
            raise ValueError(
                f"{task_path}: criterion '{criterion['id']}' deliverables must be a list of filenames"
            )

def evaluate_run(run_id: str, task: str, judge: Judge, parallel: int = 6) -> dict:
    """Score a run against the rubric defined in task.json.

    Returns a scores dict with: run_id, task, score, max_score,
    criteria_results, summary, cost, doc_coverage.
    """
    task_dir = paths.task_dir(task)
    run_dir = paths.results_dir() / run_id

    # Load task config
    config_path = task_dir / "task.json"
    if not config_path.exists():
        raise FileNotFoundError(f"task.json not found: {config_path}")
    config = json.loads(config_path.read_text(encoding="utf-8"))

    # Validate and extract required fields
    validate_task_config(config=config, task_path=config_path)

    if not run_dir.exists():
        raise FileNotFoundError(f"run directory not found: {run_dir}")

    criteria = config["criteria"]
    task_desc = config["title"]

    result = score_rubric(
        criteria=criteria,
        run_dir=run_dir,
        judge=judge,
        task_desc=task_desc,
        parallel=parallel,
    )

    n_criteria = len(result.criteria_results)
    n_passed = sum(1 for c in result.criteria_results if c["verdict"] == "pass")
    all_pass = n_criteria > 0 and n_passed == n_criteria

    summary = (
        f"{n_passed}/{n_criteria} criteria passed."
        + ("  ALL-PASS." if all_pass else f"  Missed {n_criteria - n_passed} — task FAIL.")
        + (f"  {result.n_grading_errors} could not be graded." if result.n_grading_errors else "")
    )

    scores = {
        "score": result.score,
        "max_score": result.max_score,
        "summary": summary,
        "all_pass": all_pass,
        "n_criteria": n_criteria,
        "n_passed": n_passed,
        "n_grading_errors": result.n_grading_errors,
        "pandoc_version": result.pandoc_version,
        "criteria_results": result.criteria_results,
        "run_id": run_id,
        "task": task,
        "judge_model": judge.model,
        "scored_at": datetime.now(timezone.utc).isoformat(),
    }

    # Load cost info and doc coverage from metrics.json
    metrics_path = run_dir / "metrics.json"
    if metrics_path.exists():
        metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
        scores["cost"] = {
            "input_tokens": metrics.get("input_tokens", 0),
            "output_tokens": metrics.get("output_tokens", 0),
            "wall_clock_seconds": metrics.get("wall_clock_seconds", 0),
        }
        scores["doc_coverage"] = {
            "documents_read": metrics.get("documents_read", 0),
            "total_documents": metrics.get("total_documents", 0),
            "documents_skipped": metrics.get("documents_skipped", 0),
            "documents_read_list": metrics.get("documents_read_list", []),
            "documents_skipped_list": metrics.get("documents_skipped_list", []),
        }

    # Write scores.json
    scores_path = run_dir / "scores.json"
    scores_path.write_text(json.dumps(scores, indent=2))

    return scores

def evaluate_run_dual(
    run_id: str,
    task: str,
    parallel: int = 6,
    judge_models: tuple[str, str] = JUDGE_MODELS,
) -> dict:
    """Score a run with two judges and average the result.

    Each judge grades every criterion independently. Per-judge results are
    preserved alongside the aggregate so single-judge artifacts are not
    overwritten. If any criterion could not be graded by either judge, the
    per-judge results are kept, no aggregate is written, and RuntimeError is raised.
    """
    if len(judge_models) != 2:
        raise ValueError("Dual evaluation requires exactly two judge models")
    if len(set(judge_models)) != 2:
        raise ValueError("Dual evaluation requires two distinct judge models")

    per_judge: dict[str, dict] = {}
    run_dir = paths.results_dir() / run_id
    out_path = run_dir / "scores_dual.json"
    # A failed re-grade must not leave an earlier complete aggregate in place.
    out_path.unlink(missing_ok=True)

    for judge_model in judge_models:
        judge = Judge(model=judge_model)
        scores = evaluate_run(
            run_id=run_id,
            task=task,
            judge=judge,
            parallel=parallel,
        )
        per_judge[judge_model] = scores
        # Move the just-written scores.json to a per-judge filename so
        # subsequent judges do not clobber it.
        scores_path = run_dir / "scores.json"
        if scores_path.exists():
            scores_path.rename(run_dir / f"scores_{judge_model}.json")

    ungraded = {model: scores["n_grading_errors"] for model, scores in per_judge.items() if scores["n_grading_errors"]}
    if ungraded:
        detail = ", ".join(f"{model}: {count}" for model, count in ungraded.items())
        raise RuntimeError(
            f"Criteria could not be graded ({detail}); {out_path.name} was not written. "
            "Re-run the evaluation to grade them."
        )

    def crit_frac(scores: dict) -> float:
        return (
            scores["n_passed"] / scores["n_criteria"]
            if scores.get("n_criteria")
            else 0.0
        )

    dual_crit = sum(crit_frac(scores) for scores in per_judge.values()) / len(
        per_judge
    )
    dual_ap = sum(
        1.0 if scores.get("all_pass") else 0.0
        for scores in per_judge.values()
    ) / len(per_judge)

    aggregate = {
        "run_id": run_id,
        "task": task,
        "scored_at": datetime.now(timezone.utc).isoformat(),
        "judges": list(judge_models),
        "judge_profile": (
            STANDARD_DUAL_JUDGE_PROFILE
            if set(judge_models) == set(JUDGE_MODELS)
            else CUSTOM_DUAL_JUDGE_PROFILE
        ),
        "per_judge": per_judge,
        "dual_criterion_pass": dual_crit,
        "dual_all_pass_rate": dual_ap,
        "all_pass": dual_ap == 1.0,
    }
    out_path.write_text(
        json.dumps(aggregate, indent=2),
        encoding="utf-8",
    )
    return aggregate
