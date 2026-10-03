# PDF Table Editor (Web)

Modular browser front end for the existing PySide6 PDF table editor. This first
slice extracts the P0-1e vector viewer into ES modules while retaining its PDF
picker, zoom slider and wheel zoom, pan, reset, WebGPU/WebGL selection, text
overlay, and render diagnostics. It currently draws parsed vector paths and a
separate text overlay; PDF image operators, clipping fidelity, and other content
that is not represented by the extracted geometry parser are not yet rendered.

## Run locally

Requires Node.js 18+ and pnpm or npm.

```sh
pnpm install
pnpm dev
```

Open the local URL printed by Vite, then choose a PDF. WebGPU requires a secure
context; localhost is suitable for local development. The page currently loads
the first page only. Multi-page editing, table detection, project JSON, text
layout, PDF image rendering, and PDF export are planned follow-up stages. Use
PDFs with vector content for evaluating this initial renderer; scanned pages
and embedded image content will be incomplete.

## Modules

- `src/features/viewer/vector-geometry.js`: curve flattening and scanline fill.
- `src/features/viewer/operator-parser.js`: PDF.js operator list to geometry.
- `src/features/viewer/geometry-batches.js`: merge geometry for GPU upload.
- `src/features/viewer/webgpu-renderer.js` / `webgl-renderer.js`: GPU backends.
- `src/features/viewer/pdf-viewer.js`: view state, input, PDF loading, overlays.
- `src/ui/styles/app.css`: presentation.

`legacy/PDF_TABLE_ED2.html` preserves the original single-file prototype.
