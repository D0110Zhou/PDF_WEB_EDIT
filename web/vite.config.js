import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function serveSystemFonts() {
  const fontDirectory = resolve(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  const systemFonts = new Map([
    ['/calibri.ttf', resolve(fontDirectory, 'calibri.ttf')],
    ['/kaiu.ttf', resolve(fontDirectory, 'kaiu.ttf')],
  ]);
  const middleware = async (request, response, next) => {
    const fontPath = systemFonts.get(request.url?.split('?')[0]);
    if (!fontPath) return next();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.end('Method Not Allowed');
      return;
    }
    try {
      const font = await readFile(fontPath);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'font/ttf');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Length', font.byteLength);
      response.end(request.method === 'HEAD' ? undefined : font);
    } catch {
      response.statusCode = 404;
      response.end('System Calibri was not found in the Windows Fonts directory.');
    }
  };
  return {
    name: 'serve-system-calibri',
    configureServer(server) {
      server.middlewares.use('/__system-font', middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/__system-font', middleware);
    },
  };
}

export default defineConfig({
  plugins: [serveSystemFonts()],
  base: './',
  server: { host: '127.0.0.1' },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
