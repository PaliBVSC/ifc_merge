# IFC Merge

Merge several (large) IFC files into one, with a lightweight 3D overview showing where each
model sits and how big it is.

There are two ways to run it:

| | Browser app (`web/`) | Local server (`app/`) |
|---|---|---|
| Where it runs | Entirely in the user's browser, hosted as a static site (e.g. Vercel) | Python/FastAPI on your machine |
| Files | Never leave the user's computer | Uploaded to, or read from, the server |
| Large files | Multi-GB in Chrome/Edge (output streams to disk); Firefox/Safari keep the result in memory | Multi-GB |
| Extras | Example models, shareable demo link `/#examples` | Server-side file paths, `.ifczip` in/out |

Both use the same algorithm; `web/engine.js` is a port of `app/analyze.py` + `app/merge.py`
and the test suite checks they agree.

## Browser app

Static files in `web/`, no build step. To try it locally:

```powershell
python -m http.server 8080 --directory web     # then open http://localhost:8080
```

Deploying on Vercel: import the repository; `vercel.json` serves `web/` as-is and
`.vercelignore` keeps the Python code out of the deployment.

## Local server

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python run.py            # opens the app in your browser
```

It prefers port 8000; if that is taken it uses the next free port and prints the address,
e.g. `IFC Merge is running at http://localhost:8001`. Requires Python 3.11+.
Options: `--port 8080`, `--host 0.0.0.0` (share on the network — anyone who can reach it can
then read files by server path), `--no-browser`. Uploaded files and results are stored in
`./data` (override with `IFC_MERGE_DATA`).

Both versions load three.js from jsDelivr, so the browser needs internet access for the 3D view.

## Using it

1. **Add models**: drag & drop `.ifc` files (local server: also `.ifczip`, or a path on the
   server machine, read in place without copying).
2. Each file is **analysed** in the background: schema, units, project, sites
   (lat/long), georeferencing, element count, and its extents.
3. The **viewer** shows each model as a coloured box (robust extents, ignoring the 0.5 %
   most extreme elements on each side) plus a sample of up to 3 000 element positions.
   Toggle *Outliers* to see the full extents, *Merged extent* for the combined box.
4. **Order** the list: the first selected model is the *primary*. Untick models to leave
   them out.
5. **Merge**. Pre-flight checks block merges that would produce a broken file (schema or
   unit mismatch) and warn about likely misalignment (different georeferencing, models
   kilometres apart).

## What the merge does

The files are streamed, never loaded into an object model, so memory stays flat:

| Step | Detail |
|---|---|
| Entity ids | Each file's `#ids` are shifted past those already written. |
| Project | Secondary `IfcProject`s are removed; their sites/buildings and declarations are re-pointed to the primary project. |
| Units | Primary units are used. Files with different length/angle units are rejected (unless forced) because geometry would be mis-scaled. |
| Contexts | A secondary representation context identical to a primary one (type, identifier, WCS, true north, map conversion) is folded into it; others are kept and added to the project. |
| GlobalIds | A GlobalId already used by an earlier file is regenerated (optional, on by default). |
| Coordinates | Unchanged. What you see in the viewer is how the models will sit in the merged file. |
| Header | `FILE_DESCRIPTION` from the primary file, new `FILE_NAME`, a comment listing source files. |

## Performance

Two synthetic 554 MB files (9.6 M entities, 1.2 M elements each), on a laptop:

| | Browser engine (V8) | Python server |
|---|---|---|
| Analyse one 554 MB file | 23–28 s, < 350 MB | 33–70 s, ~190 MB |
| Merge both → 1.1 GB, with GlobalId de-duplication | ~17 s, < 470 MB | ~74 s (~43 s without), ~130 MB + ~180 B per GlobalId |

## How the extents are computed

For every physical element (`IfcProduct` with an `ObjectPlacement`, excluding spatial
containers, openings, grids and annotations) the `IfcLocalPlacement` chain is resolved to
a world position. Extents are the bounding box of these element origins — a good, cheap
proxy for size and location. If all elements share one origin (some exporters write
geometry in absolute coordinates), a sample of raw geometry points is used instead and the
card says *geometry points (approximate)*.

## Limitations

* All files must use the same IFC schema; no schema conversion.
* No unit conversion: re-export mismatching files in the same units.
* No coordinate transformation: models are merged in their own coordinates. If the
  viewer shows them far apart, they will be far apart in the merged file too.
* Sites / buildings / storeys with the same name are not merged with each other; each
  model keeps its own spatial tree under the common project.
* `ifcXML` and `ifcJSON` are not supported.

## Development

```powershell
.venv\Scripts\pip install -r requirements-dev.txt
.venv\Scripts\python -m pytest tests                       # Python + browser engine (via Node), validated with ifcopenshell
.venv\Scripts\python -m tests.make_samples samples         # small demo models
.venv\Scripts\python -m tests.make_large big.ifc 1200000   # ~550 MB stress-test file
node web/cli.mjs merge out.ifc a.ifc b.ifc                 # run the browser engine from the command line
```

Code map: `web/engine.js` (browser engine), `web/app.js` + `web/worker.js` (UI, Web Worker),
`web/viewer.js` (three.js overview, shared), `app/` (Python reference + FastAPI server),
`static/` (local server UI), `tests/`.
