"""Render frozen submissions before rubric evaluation; never execute their code."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

import fitz
from PIL import Image

OFFICE = {".docx", ".doc", ".odt", ".pptx", ".ppt", ".odp", ".xlsx", ".xls", ".ods"}
TEXT = {".txt", ".md", ".csv", ".json", ".html", ".xml", ".py", ".js"}
IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".tiff", ".bmp"}


def render_tree(source, destination):
    source, destination = Path(source), Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    records, images = [], []
    files = sorted(p for p in source.rglob("*") if p.is_file()) if source.exists() else []
    if len(files) > 100 or sum(p.stat().st_size for p in files) > 512 * 1024 * 1024:
        raise ValueError("submission exceeds render limit")
    for index, file in enumerate(files):
        if file.is_symlink():
            raise ValueError("symlink in submission")
        output = destination / str(index)
        output.mkdir()
        record = {"path": str(file.relative_to(source)), "bytes": file.stat().st_size,
                  "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "pages": [], "text": ""}
        suffix = file.suffix.lower()
        pdf = file if suffix == ".pdf" else None
        if suffix in OFFICE:
            with tempfile.TemporaryDirectory(prefix="gdpval-libreoffice-") as profile:
                # Credentials are never part of renderer process environment.
                env = {k: os.environ[k] for k in ["PATH", "LANG"] if k in os.environ}
                result = subprocess.run(["libreoffice", "--headless", "-env:UserInstallation=" + Path(profile).as_uri(),
                    "--convert-to", "pdf", "--outdir", str(output), str(file)], env=env, capture_output=True, timeout=180)
                pdf = output / (file.stem + ".pdf")
                if result.returncode or not pdf.is_file():
                    # Malformed candidate output is a readable grading finding.
                    record["error"] = "document_cannot_be_opened"
                    records.append(record)
                    continue
        if pdf:
            try:
                doc = fitz.open(pdf)
            except Exception:
                record["error"] = "document_cannot_be_opened"
                records.append(record)
                continue
            if len(doc) > 80:
                raise ValueError("document exceeds page limit; evidence would be incomplete")
            for page_index, page in enumerate(doc):
                image = output / f"page-{page_index + 1}.png"
                page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False).save(image)
                images.append(str(image))
                record["pages"].append(str(image))
                record["text"] += f"\n[Page {page_index + 1}]\n" + page.get_text()
            doc.close()
        elif suffix in IMAGES:
            image = output / "image.png"
            with Image.open(file) as original:
                original.convert("RGB").save(image)
            images.append(str(image)); record["pages"].append(str(image))
        elif suffix in TEXT:
            record["text"] = file.read_text(errors="replace")
        else:
            raise ValueError(f"renderer unavailable for {suffix}; cannot issue a complete quality score")
        if suffix in {".xlsx", ".xlsm"}:
            from openpyxl import load_workbook
            workbook = load_workbook(file, data_only=False, read_only=True)
            record["workbook"] = [{"name": sheet.title, "cells": [[cell.value for cell in row] for row in sheet]} for sheet in workbook]
            workbook.close()
        records.append(record)
    if len(images) > 80 or len(json.dumps(records, default=str)) > 300000:
        raise ValueError("render evidence exceeds judge input limit")
    (destination / "manifest.json").write_text(json.dumps(records, indent=2, default=str))
    return records, images
