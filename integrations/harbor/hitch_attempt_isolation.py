"""Host verification of declared and resolved per-attempt Docker boundaries."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re
import sys
import tomllib
import yaml

ATTEMPT_ISOLATION_PROTOCOL = "hitch-attempt-isolation@1"
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*\Z")

def project_name(labels, session, trial):
    if not session or not trial:
        raise ValueError("attempt isolation requires a host trial identity")
    identity = {"ownership": labels, "session": session, "trial": str(Path(trial).resolve())}
    return "hitch-" + hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:48]

def _relative(root, value):
    return isinstance(value, str) and value and not any(c in value for c in ("$", "\\", "\0")) and not Path(value).is_absolute() and ".." not in Path(value).parts and (root / value).resolve().is_relative_to(root.resolve())

def blockers(document, *, resolved=False, project=None, trial=None, readonly=()):
    errors=[]
    readonly = tuple(str(Path(value).resolve()) for value in readonly)
    if not isinstance(document, dict): return ["Compose is not a mapping"]
    if any(key in document for key in ("include", "extends")): errors.append("external Compose composition")
    if document.get("configs") or document.get("secrets"): errors.append("external config or secret resources")
    for kind in ("networks", "volumes"):
        for name, resource in (document.get(kind) or {}).items():
            resource = resource or {}
            if not isinstance(resource, dict): errors.append(kind+": invalid resource");continue
            expected = f"{project}_{name}"
            if resource.get("external") or (resource.get("name") and (not resolved or resource["name"] != expected)):
                errors.append(kind+": external or fixed name")
            if any(resource.get(key) for key in ("driver_opts", "ipam")) or resource.get("driver") not in (None, "bridge" if kind == "networks" else "local"):
                errors.append(kind+": shared/custom driver state")
    services=document.get("services") or {}
    if not isinstance(services, dict): return errors+["invalid Compose services"]
    for name, service in services.items():
        if not isinstance(service, dict): errors.append(name+": invalid service");continue
        if service.get("configs") or service.get("secrets"): errors.append(name+": external config or secret attachment")
        if service.get("container_name") or service.get("ports") or service.get("volumes_from") or service.get("external_links"):
            errors.append(name+": global container, published port or inherited volume")
        if any(service.get(key) for key in ("extends", "profiles", "develop", "devices", "device_cgroup_rules", "privileged", "cgroup_parent", "userns_mode", "uts", "pid", "ipc")):
            errors.append(name+": shared host namespace or unsupported service lifecycle")
        if any(str(cap).upper().removeprefix("CAP_") in {"ALL", "SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE"} for cap in service.get("cap_add", [])):
            errors.append(name+": host privilege")
        network=service.get("network_mode")
        if network not in (None,"none") and (not isinstance(network,str) or not network.startswith("service:") or network[8:] not in services):
            errors.append(name+": external network namespace")
        if service.get("build") and service.get("image") and not resolved: errors.append(name+": shared mutable build image tag")
        for mount in service.get("volumes", []):
            if isinstance(mount,str):
                parts=mount.split(":")
                if len(parts)==1 and parts[0].startswith("/"):continue
                if len(parts)>=2 and _NAME.fullmatch(parts[0]) and parts[1].startswith("/"):continue
                errors.append(name+": host bind volume");continue
            if not isinstance(mount,dict): errors.append(name+": invalid mount");continue
            if mount.get("type")=="volume" and (not mount.get("source") or _NAME.fullmatch(mount["source"])):continue
            if mount.get("type")=="tmpfs":continue
            if resolved and mount.get("type")=="bind" and isinstance(mount.get("source"),str):
                source=Path(mount["source"]).resolve()
                if trial and source.is_relative_to(Path(trial).resolve()):continue
                if mount.get("read_only") is True and str(source) in readonly:continue
            errors.append(name+": host bind volume")
    return errors

def inspect_task(directory):
    root=Path(directory).resolve(); errors=[]
    try:
        task=tomllib.loads((root/"task.toml").read_text())
        if task.get("steps"):errors.append("multi-step external environment lifecycle")
        for group in (task.get("environment",{}),task.get("verifier",{}).get("environment",{})):
            if str(group.get("os","linux")).lower() != "linux":errors.append("non-Linux environment")
            if any(str(k).startswith(("DOCKER_","COMPOSE_")) for k in (group.get("env") or {})):errors.append("Docker control environment override")
        for role in ("environment","tests"):
            context=root/role
            if (context/".env").exists():errors.append(role+": dynamic Compose environment")
            source=context/"docker-compose.yaml"
            document=yaml.safe_load(source.read_text()) if source.exists() else {"services":{}}
            if source.is_symlink():errors.append(role+": symlink Compose input")
            errors.extend(role+": "+reason for reason in blockers(document or {"services":{}}))
            builds=[(context,"Dockerfile")]
            for service in (document or {}).get("services",{}).values():
                build=service.get("build")
                if not build:continue
                build={"context":build} if isinstance(build,str) else build
                if not isinstance(build,dict) or set(build)-{"context","dockerfile","args","target","labels"} or not _relative(context,build.get("context",".")) or not _relative(context,build.get("dockerfile","Dockerfile")):
                    errors.append(role+": external/dynamic build input");continue
                builds.append((context/build.get("context","."),build.get("dockerfile","Dockerfile")))
            for base,file in builds:
                dockerfile=base/file
                if dockerfile.exists() and (dockerfile.is_symlink() or re.search(r"--mount(?:=|\s)|--device(?:=|\s)|--security(?:=|\s)",dockerfile.read_text())):
                    errors.append(role+": shared build mount or privilege")
    except (OSError,ValueError,TypeError,AttributeError) as error:errors.append("inspection unavailable: "+str(error)[:200])
    return {"protocol":ATTEMPT_ISOLATION_PROTOCOL,"supported":not errors,"blockers":sorted(set(errors))}

def assert_resolved(document, project, trial, readonly=()):
    errors=blockers(document,resolved=True,project=project,trial=trial,readonly=readonly)
    if errors:raise ValueError("isolated attempt configuration rejected: "+"; ".join(errors))

if __name__ == "__main__":
    print(json.dumps(inspect_task(sys.argv[1])))
