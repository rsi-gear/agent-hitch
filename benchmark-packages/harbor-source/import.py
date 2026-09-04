#!/usr/bin/env python3
"""Harbor Hub -> standard package producer. Requires harbor==0.21.0; no Hitch imports.

Sample complete release membership before reading task contents. The source
tasks are downloaded by immutable content hash. Preserve schema/image changes.
"""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

import toml
import yaml
from harbor.models.registry import DatasetMetadata
from harbor.models.task.config import TaskConfig
from harbor.registry.client.package import PackageDatasetClient
from harbor.tasks.client import TaskClient
from harbor.publisher.packager import Packager


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def sample(tasks, seed, count):
    if not 0 < count <= len(tasks):
        raise ValueError("sample count must be between one and population size")
    names = [t.name for t in tasks]
    if len(names) != len(set(names)):
        raise ValueError("duplicate task names in membership")
    return sorted(tasks, key=lambda t: hashlib.sha256(f"{seed}\0{t.name}".encode()).hexdigest())[:count]


def pin_image(image, cache):
    if re.search(r"@sha256:[0-9a-f]{64}$", image):
        return image
    if image in cache:
        return cache[image]
    output = subprocess.check_output(["docker", "buildx", "imagetools", "inspect", image], text=True)
    match = re.search(r"^Digest:\s+(sha256:[0-9a-f]{64})\s*$", output, re.M)
    if not match:
        raise ValueError(f"cannot resolve image {image}")
    cache[image] = image + "@" + match[1]
    return cache[image]


def transform_file(root, file, text, transformations):
    if file.read_text() == text:
        return
    relative = file.relative_to(root)
    before = Path("source-files") / relative
    (root / before).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(file, root / before)
    file.write_text(text)
    transformations.append({"kind": "pin-image-or-normalize-harbor-schema", "before_path": str(before), "after_path": str(relative)})


async def produce(args):
    root = Path(args.out).resolve()
    if root.exists():
        raise ValueError("output already exists; refusing to overwrite a package")
    client = PackageDatasetClient()
    if args.metadata:
        metadata = DatasetMetadata.model_validate_json(Path(args.metadata).read_text())
    else:
        if not re.fullmatch(r"[\w-]+/[\w-]+@(?:\d+\.\d+\.\d+|sha256:[a-f0-9]{64})", args.dataset or ""):
            raise ValueError("--dataset requires an exact version or content hash")
        metadata = await client.get_dataset_metadata(args.dataset)
    selected = sample(metadata.task_ids, args.seed, args.count)
    population = sorted([t.model_dump(mode="json") for t in metadata.task_ids], key=lambda t: t["name"])
    selection = {"algorithm": "sha256-rank-v1", "seed": args.seed, "population_size": len(population),
                 "population_digest": digest(canonical(population)), "tasks": [t.model_dump(mode="json") for t in selected]}
    root.mkdir(parents=True)
    # Persist selection before downloading/inspecting any sampled task.
    write_json(root / "source-manifest.json", {"selection": selection, "status": "importing"})
    with tempfile.TemporaryDirectory(prefix="hitch-harbor-source-") as temporary:
        if args.source:
            source = Path(args.source)
        else:
            source = Path(temporary)
            await TaskClient().download_tasks(selected, output_dir=source, export=True)
        transformations, image_cache, requirements = [], {}, set()
        for task in selected:
            actual_hash, _ = Packager.compute_content_hash(source / task.name)
            if task.ref != "sha256:" + actual_hash:
                raise ValueError(f"upstream content hash mismatch: {task.name}")
            target = root / "tasks" / task.name
            shutil.copytree(source / task.name, target, symlinks=True)
            for p in target.rglob("*"):
                if p.is_symlink():
                    raise ValueError(f"upstream symlink requires an explicit adapter: {p}")
            config_path = target / "task.toml"
            raw = toml.loads(config_path.read_text())
            normalized = TaskConfig.model_validate(raw).model_dump(mode="json", exclude_none=True)
            normalized["schema_version"] = "1.4"
            if normalized.get("steps"):
                raise ValueError("multi-step task needs a compatible executor")
            normalized.pop("steps", None)
            normalized.pop("multi_step_reward_strategy", None)
            for env in [normalized["environment"], normalized["verifier"].get("environment")]:
                if env and env.get("docker_image"):
                    env["docker_image"] = pin_image(env["docker_image"], image_cache)
            transform_file(root, config_path, toml.dumps(normalized), transformations)
            for file in target.rglob("Dockerfile*"):
                if not file.is_file():
                    continue
                stages, lines, continued = set(), [], False
                for line in file.read_text().splitlines(keepends=True):
                    m = None if continued else re.match(r"^(\s*FROM\s+(?:--platform=\S+\s+)?)(\S+)(.*)$", line, re.I)
                    if line.strip() and not line.lstrip().startswith("#"):
                        continued = line.rstrip().endswith("\\")
                    if m:
                        image = m[2]
                        if image != "scratch" and image.lower() not in stages:
                            image = pin_image(image, image_cache)
                        line = m[1] + image + m[3] + ("\n" if line.endswith("\n") else "")
                        alias = re.search(r"\bAS\s+(\S+)", m[3], re.I)
                        if alias:
                            stages.add(alias[1].lower())
                    lines.append(line)
                transform_file(root, file, "".join(lines), transformations)
            for file in target.rglob("docker-compose.y*ml"):
                compose = yaml.safe_load(file.read_text())
                for service in compose.get("services", {}).values():
                    if service.get("image"):
                        service["image"] = pin_image(service["image"], image_cache)
                # JSON is a YAML subset; deterministic and avoids YAML coercion.
                transform_file(root, file, json.dumps(compose, indent=2) + "\n", transformations)
            mode = normalized["verifier"].get("environment_mode", "shared")
            caps = ["shell", mode + "-verifier"]
            artifacts = normalized.get("artifacts", [])
            paths = [a if isinstance(a, str) else a["source"] for a in artifacts]
            if paths:
                caps.append("artifact-export")
            if (target / "environment/docker-compose.yaml").is_file():
                caps.append("compose")
            requirements.update(caps)
            write_json(target / "task.hitch.json", {
                "schema_version": "1", "source_task_id": f"{task.org}/{task.name}@{task.ref}",
                "driver": {"kind": "terminal", "protocol_version": "1", "config": {}},
                "requirements": caps, "lifecycle": {},
                "submission": {"kind": "artifacts" if paths else "environment", "paths": paths, "max_bytes": 1073741824},
                "grading": {"kind": "harbor", "entrypoint": ["bash", "/tests/test.sh"], "metric_map": {"resolved": "reward"}},
                "extensions": {"verifier_isolation": mode, "upstream_task_ref": task.model_dump(mode="json")}})
        shutil.copy2(__file__, root / "source-adapter.py")
        manifest = {"schema_version": "1", "protocol": "hitch-benchmark@1", "id": metadata.name,
                    "release": metadata.version, "task_root": "tasks", "task_ids": [t.name for t in selected],
                    "default_profile": "profiles/default.json", "primary_metric": "resolved", "runtime_components": [],
                    "task_format": {"name": "harbor", "schema_version": "1.4"},
                    "source": {"kind": "local", "path": ".", "license": args.license, "access": "public"},
                    "metrics": {"resolved": {"type": "binary", "direction": "maximize", "range": [0, 1], "reducer": "task_macro_mean"}},
                    "publication": {"track": "public-subset", "training_eligible": False}}
        (root / "benchmark.toml").write_text(toml.dumps(manifest))
        write_json(root / "profiles/default.json", {"schema_version": "1", "id": metadata.name + "/hitch-terminal",
            "track": "public-subset", "input_mode": "instruction", "tool_policy": {"id": "native-harbor-terminal", "allowed": sorted(requirements), "network": "open", "enforcement": "required"},
            "budget": {"agent_timeout": {"source": "task"}, "setup_timeout_ms": 7200000, "collection_timeout_ms": 600000, "cleanup_grace_ms": 60000},
            "sampling": {"attempts_per_task": 1, "seed": args.seed},
            "grading": {"on_agent_budget_exhausted": "grade_final_state", "on_missing_submission": "error", "infrastructure_retries": 0},
            "extensions": {"selection": selection, "model_seed_supported": False}})
        write_json(root / "source-manifest.json", {"schema_version": "1", "status": "ready", "registry": metadata.model_dump(mode="json"),
            "selection": selection, "resolved_images": image_cache, "transformations": transformations,
            "adapter": {"id": "harbor-source", "version": "1", "path": "source-adapter.py"},
            "usage_conditions": "Benchmark data must not appear in training corpora. Preserve upstream canaries and task licenses."})
        print(json.dumps({"package": str(root), "selection": selection}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset")
    parser.add_argument("--metadata")
    parser.add_argument("--source", help="already downloaded export matching the frozen registry manifest")
    parser.add_argument("--seed", required=True, type=int)
    parser.add_argument("--count", type=int, default=2)
    parser.add_argument("--license", default="See upstream task/source license")
    parser.add_argument("--out", required=True)
    asyncio.run(produce(parser.parse_args()))
