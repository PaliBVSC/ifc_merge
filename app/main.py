"""FastAPI server: upload / register IFC files, analyse them, merge them."""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import traceback
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import analyze as analyzer
from . import merge as merger

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("IFC_MERGE_DATA", os.path.join(ROOT, "data"))
UPLOADS = os.path.join(DATA, "uploads")
META = os.path.join(DATA, "files")
OUTPUTS = os.path.join(DATA, "outputs")
for d in (UPLOADS, META, OUTPUTS):
    os.makedirs(d, exist_ok=True)

app = FastAPI(title="IFC Merge")
analysis_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="analyze")
merge_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="merge")
lock = threading.Lock()
files: dict[str, dict] = {}
jobs: dict[str, dict] = {}


# --------------------------------------------------------------------- registry

def _save(rec: dict):
    with open(os.path.join(META, rec["id"] + ".json"), "w", encoding="utf-8") as fh:
        json.dump(rec, fh)


def _public(rec: dict) -> dict:
    return {k: v for k, v in rec.items() if k != "analysis"} | {
        "analysis": _strip(rec.get("analysis"))
    }


def _strip(a):
    if not a:
        return a
    return {k: v for k, v in a.items() if k not in ("data_start", "data_end", "file_description")}


def _load_registry():
    for name in os.listdir(META):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(META, name), encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            continue
        if not os.path.exists(rec["path"]):
            continue
        st = os.stat(rec["path"])
        files[rec["id"]] = rec
        if rec["status"] != "ready" or rec.get("mtime") != st.st_mtime or rec.get("size") != st.st_size:
            _queue_analysis(rec)


def _queue_analysis(rec: dict):
    st = os.stat(rec["path"])
    rec.update(status="queued", progress=0.0, stage="Queued", error=None,
               size=st.st_size, mtime=st.st_mtime)
    analysis_pool.submit(_run_analysis, rec)


def _run_analysis(rec: dict):
    def progress(p, stage):
        rec["progress"], rec["stage"] = round(p, 3), stage

    rec["status"] = "analyzing"
    t0 = time.time()
    try:
        rec["analysis"] = analyzer.analyze(rec["path"], progress)
        rec["status"], rec["stage"] = "ready", f"Analysed in {time.time() - t0:.1f}s"
    except Exception as exc:  # noqa: BLE001 - report anything to the UI
        traceback.print_exc()
        rec["status"], rec["error"] = "error", str(exc)
    rec["progress"] = 1.0
    if rec["id"] in files:
        _save(rec)
    elif rec["source"] == "upload":  # removed while analysing
        try:
            os.remove(rec["path"])
        except OSError:
            pass


def _register(path: str, name: str, source: str) -> dict:
    rec = {"id": uuid.uuid4().hex[:12], "name": name, "path": path, "source": source,
           "added": time.time(), "analysis": None}
    with lock:
        files[rec["id"]] = rec
    _queue_analysis(rec)
    _save(rec)
    return rec


def _unzip_ifc(zip_path: str, dest: str) -> str:
    with zipfile.ZipFile(zip_path) as z:
        members = [m for m in z.namelist() if m.lower().endswith(".ifc")]
        if not members:
            raise HTTPException(400, "The .ifczip archive contains no .ifc file")
        with z.open(members[0]) as src, open(dest, "wb") as dst:
            shutil.copyfileobj(src, dst, 16 << 20)
    return dest


_SAFE = re.compile(r"[^A-Za-z0-9._\- ()]+")


def _safe_name(name: str) -> str:
    name = _SAFE.sub("_", os.path.basename(name or "")).strip() or "model.ifc"
    return name[:120]


# --------------------------------------------------------------------- file API

@app.get("/api/files")
def list_files():
    return sorted((_public(r) for r in files.values()), key=lambda r: r["added"])


@app.put("/api/upload")
async def upload(request: Request, name: str):
    name = _safe_name(name)
    ext = os.path.splitext(name)[1].lower()
    if ext not in (".ifc", ".ifczip"):
        raise HTTPException(400, "Only .ifc and .ifczip files are supported")
    fid = uuid.uuid4().hex[:12]
    raw = os.path.join(UPLOADS, f"{fid}{ext}")
    with open(raw, "wb") as fh:
        async for chunk in request.stream():
            fh.write(chunk)
    path = raw
    if ext == ".ifczip":
        path = _unzip_ifc(raw, os.path.join(UPLOADS, f"{fid}.ifc"))
        os.remove(raw)
        name = name[:-3]
    return _public(_register(path, name, "upload"))


class PathIn(BaseModel):
    path: str


@app.post("/api/files/path")
def add_path(body: PathIn):
    path = os.path.abspath(os.path.expanduser(body.path.strip().strip('"')))
    if not os.path.isfile(path):
        raise HTTPException(400, f"File not found on server: {path}")
    if path.lower().endswith(".ifczip"):
        fid = uuid.uuid4().hex[:12]
        extracted = _unzip_ifc(path, os.path.join(UPLOADS, f"{fid}.ifc"))
        return _public(_register(extracted, os.path.basename(path)[:-3], "upload"))
    if not path.lower().endswith(".ifc"):
        raise HTTPException(400, "Only .ifc and .ifczip files are supported")
    return _public(_register(path, os.path.basename(path), "path"))


@app.delete("/api/files/{fid}")
def remove_file(fid: str):
    rec = files.pop(fid, None)
    if not rec:
        raise HTTPException(404, "Unknown file")
    try:
        os.remove(os.path.join(META, fid + ".json"))
        if rec["source"] == "upload":
            os.remove(rec["path"])
    except OSError:
        pass  # still being analysed on Windows; harmless leftover
    return {"ok": True}


@app.post("/api/files/{fid}/reanalyze")
def reanalyze(fid: str):
    rec = files.get(fid)
    if not rec:
        raise HTTPException(404, "Unknown file")
    _queue_analysis(rec)
    return _public(rec)


# --------------------------------------------------------------------- merge API

class MergeIn(BaseModel):
    file_ids: list[str]
    output_name: str = "merged.ifc"
    options: dict = {}


def _infos(ids):
    out = []
    for fid in ids:
        rec = files.get(fid)
        if not rec:
            raise HTTPException(404, f"Unknown file {fid}")
        if rec["status"] != "ready":
            raise HTTPException(409, f"{rec['name']} is not analysed yet")
        out.append({"path": rec["path"], "name": rec["name"], "analysis": rec["analysis"]})
    return out


@app.post("/api/preflight")
def preflight(body: MergeIn):
    return merger.preflight(_infos(body.file_ids), body.options)


@app.post("/api/merge")
def start_merge(body: MergeIn):
    infos = _infos(body.file_ids)
    check = merger.preflight(infos, body.options)
    if check["errors"]:
        raise HTTPException(400, "\n".join(check["errors"]))
    name = _safe_name(body.output_name)
    if not name.lower().endswith(".ifc"):
        name = os.path.splitext(name)[0] + ".ifc"
    jid = uuid.uuid4().hex[:12]
    out_dir = os.path.join(OUTPUTS, jid)
    os.makedirs(out_dir)
    job = {"id": jid, "status": "running", "progress": 0.0, "stage": "Starting", "error": None,
           "result": None, "name": name, "started": time.time(), "files": [i["name"] for i in infos]}
    jobs[jid] = job

    def run():
        def progress(p, stage):
            job["progress"], job["stage"] = round(p, 3), stage
        try:
            res = merger.merge(infos, os.path.join(out_dir, name), body.options, progress)
            res["filename"] = os.path.basename(res["path"])
            res["seconds"] = round(time.time() - job["started"], 1)
            job["result"], job["status"] = res, "done"
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            job["status"], job["error"] = "error", str(exc)

    merge_pool.submit(run)
    return job


@app.get("/api/jobs/{jid}")
def job_status(jid: str):
    job = jobs.get(jid)
    if not job:
        raise HTTPException(404, "Unknown job")
    return job


@app.get("/api/jobs/{jid}/download")
def download(jid: str):
    job = jobs.get(jid)
    if not job or job["status"] != "done":
        raise HTTPException(404, "Result not available")
    path = job["result"]["path"]
    media = "application/zip" if path.endswith(".ifczip") else "application/x-step"
    return FileResponse(path, media_type=media, filename=os.path.basename(path))


@app.delete("/api/jobs/{jid}")
def delete_job(jid: str):
    job = jobs.pop(jid, None)
    if not job:
        raise HTTPException(404, "Unknown job")
    shutil.rmtree(os.path.join(OUTPUTS, jid), ignore_errors=True)
    return {"ok": True}


@app.get("/viewer.js")
def shared_viewer():
    return FileResponse(os.path.join(ROOT, "web", "viewer.js"), media_type="text/javascript")


@app.get("/style.css")
def shared_style():
    return FileResponse(os.path.join(ROOT, "web", "style.css"), media_type="text/css")


_load_registry()
app.mount("/", StaticFiles(directory=os.path.join(ROOT, "static"), html=True), name="static")
