"""Benchmark-neutral score artifacts derived from AutomationBench assertions."""

from __future__ import annotations

import math


def process_evidence(assertions, score):
    if not isinstance(assertions, list):
        raise ValueError("AutomationBench assertions must be a list")
    components = []
    for index, assertion in enumerate(assertions, start=1):
        if not isinstance(assertion, dict):
            raise ValueError("AutomationBench assertion must be an object")
        assertion_type = assertion.get("type")
        passed = assertion.get("passed")
        excluded = assertion.get("excluded")
        if not isinstance(assertion_type, str) or not assertion_type:
            raise ValueError("AutomationBench assertion type is invalid")
        if not isinstance(passed, bool) or not isinstance(excluded, bool):
            raise ValueError("AutomationBench assertion status is invalid")
        components.append({
            "id": f"assertion-{index:04d}",
            "category": assertion_type,
            "code": assertion_type,
            "status": "excluded" if excluded else "passed" if passed else "failed",
            "weight": 1,
        })
    scored = [component for component in components if component["status"] != "excluded"]
    passed_count = sum(component["status"] == "passed" for component in scored)
    aggregate = passed_count / len(scored) if scored else 0
    numeric_score = float(score)
    if not math.isfinite(numeric_score) or not math.isclose(numeric_score, aggregate, rel_tol=0, abs_tol=1e-12):
        raise ValueError("AutomationBench partial_credit differs from assertion aggregation")
    return {
        "schema_version": "1",
        "metric": "partial_credit",
        "score": numeric_score,
        "detail_status": "components",
        "passed": passed_count,
        "total": len(scored),
        "excluded": len(components) - len(scored),
        "components": components,
    }
