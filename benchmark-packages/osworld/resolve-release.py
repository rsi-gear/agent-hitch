#!/usr/bin/env python3
"""Resolve official OSWorld release metadata and sample public task IDs.

This prepares provenance and membership only. It does not fetch gated task
contents, accept terms, provision a VM, or claim that a benchmark was executed.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request


def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def digest(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def resolve(args):
    if not re.fullmatch(r"osworld-v2-\d{4}\.\d{2}\.\d{2}", args.release):
        raise ValueError("invalid official release name")
    root = Path(args.out).resolve()
    if root.exists():
        raise ValueError("output already exists; never overwrite a locked sample")
    manifest_url = "https://raw.githubusercontent.com/xlang-ai/OSWorld-V2/main/benchmark_releases/" + args.release + ".json"
    manifest = fetch(manifest_url)
    if manifest["release"] != args.release or manifest["schema_version"] != 1:
        raise ValueError("unsupported or mismatched release manifest")
    urls = {}
    for component in ["osworld_code", "website_code", "tasks", "assets"]:
        record = manifest[component]
        repository = record["repository"]
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository):
            raise ValueError("invalid component repository")
        tag = urllib.parse.quote(record["tag"], safe="")
        urls[component] = ("https://api.github.com/repos/" + repository + "/commits/" + tag
            if component.endswith("_code") else "https://huggingface.co/api/datasets/" + repository + "/revision/" + tag)
    with ThreadPoolExecutor(max_workers=4) as pool:
        metadata = dict(zip(urls, pool.map(fetch, urls.values())))
    components = {}
    for name, data in metadata.items():
        if not re.fullmatch(r"[a-f0-9]{40}", data["sha"]):
            raise ValueError("component revision is not immutable")
        components[name] = {**manifest[name], "resolved_revision": data["sha"],
            "metadata_url": urls[name], "metadata_digest": digest(data)}
    files = sorted(r["rfilename"] for r in metadata["tasks"]["siblings"] if re.fullmatch(r"task_\d+\.py", r["rfilename"]))
    expected = manifest["task_hash_manifest"]
    if len(files) != len(set(files)) or len(files) != expected["task_count"]:
        raise ValueError("public membership differs from the official release count")
    if not 0 < args.count <= len(files):
        raise ValueError("invalid sample count")
    ids = [name.removesuffix(".py") for name in files]
    selected = sorted(ids, key=lambda name: hashlib.sha256(f"{args.seed}\0{name}".encode()).hexdigest())[:args.count]
    result = {"schema_version": "1", "release": args.release,
        "status": "membership_locked_execution_pending", "manifest_url": manifest_url,
        "manifest_digest": digest(manifest), "components": components,
        "selection": {"algorithm": "sha256-rank-v1", "seed": args.seed, "population_size": len(ids),
            "population_digest": digest(ids), "tasks": selected, "resample_on_failure": False},
        "task_hash_manifest": expected, "declared_provider_images": manifest["provider_images"],
        "pending": ["authorized task_hash_manifest verified against its release SHA256", "selected task classes verified against the task hash manifest", "matching authorized assets", "desktop/VM execution integration and two real scored trials"]}
    root.mkdir(parents=True)
    for name, value in {"release": manifest, **metadata, "selection-lock": result}.items():
        (root / (name + ".json")).write_text(json.dumps(value, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", default="osworld-v2-2026.08.08")
    parser.add_argument("--seed", required=True, type=int)
    parser.add_argument("--count", type=int, default=2)
    parser.add_argument("--out", required=True)
    resolve(parser.parse_args())
