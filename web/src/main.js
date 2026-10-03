import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { App } from './features/viewer/pdf-viewer.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const app = new App(pdfjsLib);
window.addEventListener('pagehide', () => app.destroy(), { once: true });
