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
context; localhost is suitable for local development. This feature slice
includes multi-page selection, drag-to-select ROI, vector grid detection,
per-cell text editing, cell geometry adjustments, JSON project import/export
using the PySide6 schema, and PDF text export. Table detection tries straight
vector lines first and falls back to PDF.js raster projections at 150 DPI. In
automatic mode, pages with image operators use the full-fidelity PDF.js
renderer; pages without them use the custom WebGPU/WebGL vector renderer.
Selecting WebGPU or WebGL forces the custom vector renderer. PDF output adds
FreeText annotations with generated appearance streams. The local Vite server
reads `C:\Windows\Fonts\calibri.ttf` and `C:\Windows\Fonts\kaiu.ttf` for
Calibri and 標楷體 preview and PDF embedding. A static deployment cannot access
the visitor's Windows Fonts directory; use the font file selectors before
exporting so those fonts can be embedded. See `GITHUB_PAGES_DEPLOY.md` for the
GitHub Pages setup and font behavior.

## Modules

- `src/features/viewer/vector-geometry.js`: curve flattening and scanline fill.
- `src/features/viewer/operator-parser.js`: PDF.js operator list to geometry.
- `src/features/viewer/geometry-batches.js`: merge geometry for GPU upload.
- `src/features/viewer/webgpu-renderer.js` / `webgl-renderer.js`: GPU backends.
- `src/features/viewer/pdfjs-renderer.js`: complete PDF.js page rendering for pages with images.
- `src/features/viewer/pdf-viewer.js`: view state, input, PDF loading, overlays.
- `src/features/tables/vector-table-detector.js`: vector line extraction and cell grid reconstruction.
- `src/features/tables/raster-table-detector.js`: PDF.js raster line projection fallback.
- `src/features/layout/text-layout.js`: wrapping, centering, and auto-fit layout.
- `src/features/project/project-service.js`: Python-compatible JSON and page-range handling.
- `src/features/pdf/pdf-export-service.js`: PDF page text export with optional embedded CJK font.
- `src/ui/styles/app.css`: presentation.

`legacy/PDF_TABLE_ED2.html` preserves the original single-file prototype.
