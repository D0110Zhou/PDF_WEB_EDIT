/**
 * @typedef {Object} RendererSelection
 * @property {Object} backend Backend implementing uploadGeometry() and render().
 * @property {string} name Human-readable active renderer name.
 * @property {'gpu'|'gl'} badgeClass Toolbar badge style.
 */

/**
 * Initial front-end boundary: UI state owns the choice, while the factory
 * hides WebGPU/WebGL initialization and context-specific cleanup.
 */
export const RENDERER_PREFERENCES = Object.freeze(['auto', 'webgpu', 'webgl']);

/** @typedef {'auto'|'webgpu'|'webgl'} RendererPreference */

/**
 * PDF renderer adapter contract. Concrete GPU backends add uploadGeometry();
 * a future PDF.js reference renderer can implement the same view operations.
 * @typedef {Object} PdfRenderer
 * @property {(width:number, height:number, dpr:number) => void} resize
 * @property {(matrix:Float32Array) => number} render
 * @property {() => void} destroy
 */
