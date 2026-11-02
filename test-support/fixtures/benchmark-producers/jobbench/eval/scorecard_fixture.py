from __future__ import annotations
def build_scorecard(results: list[dict]) -> dict[str, float | int]:
    total_score = sum(result["result"]["score"] for result in results)
    max_score = sum(result["weight"] for result in results)
    passed_count = sum(1 for result in results if result["result"]["passed"])
    total_count = len(results)
    normalized = round(total_score / max_score, 4) if max_score > 0 else 0.0
    pass_rate = round(passed_count / total_count, 4) if total_count > 0 else 0.0

    scorecard: dict[str, float | int] = {
        "total_score": total_score,
        "max_score": max_score,
        "normalized_score": normalized,
        "pass_rate": pass_rate,
        "passed_count": passed_count,
        "total_count": total_count,
    }
    for result in results:
        idx = result["index"]
        scorecard[f"rubric_{idx}_passed"] = 1 if result["result"]["passed"] else 0
        scorecard[f"rubric_{idx}_score"] = result["result"]["score"]
    return scorecard

def build_reward(scorecard: dict[str, float | int]) -> dict[str, float]:
    return {"reward": float(scorecard.get("normalized_score", 0.0))}
