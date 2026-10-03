import { WebGLBackend } from './webgl-renderer.js';
import { WebGPUBackend } from './webgpu-renderer.js';

/**
 * Select and initialize a renderer. A fresh canvas is supplied for each
 * attempt because browsers bind a canvas permanently to its first context type.
 */
export async function createRenderer(preference, getFreshCanvas, onAttempt = () => {}) {
  const attempts = preference === 'webgpu'
    ? ['webgpu']
    : preference === 'webgl'
      ? ['webgl']
      : ['webgpu', 'webgl'];

  let lastError;
  for (const kind of attempts) {
    const canvas = getFreshCanvas();
    let backend;
    try {
      if (kind === 'webgpu') {
        backend = new WebGPUBackend(canvas);
        await backend.init();
        onAttempt('✓ WebGPU 初始化成功（4× MSAA）');
        return { backend, name: 'WebGPU (4× MSAA)', badgeClass: 'gpu' };
      }
      backend = new WebGLBackend(canvas);
      onAttempt('✓ WebGL 初始化成功（降級路徑）');
      return { backend, name: 'WebGL (antialias)', badgeClass: 'gl' };
    } catch (error) {
      backend?.destroy?.();
      backend?.destroyGeometry?.();
      lastError = error;
      onAttempt(`✗ ${kind.toUpperCase()} 失敗: ${error.message}`);
    }
  }
  throw lastError ?? new Error('沒有可用的渲染後端');
}
