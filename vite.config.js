import { defineConfig } from 'vite';
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// After the build, write the list of every file in ./dist into dist/sw.js
// so the service worker can pre-cache the whole app for offline use.
function precacheManifest() {
  return {
    name: 'enotes-precache',
    apply: 'build',
    closeBundle() {
      const dist = join(process.cwd(), 'dist');
      const files = [];
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(relative(dist, full).split('\\').join('/'));
        }
      };
      walk(dist);
      const list = files.filter((f) => f !== 'sw.js' && !f.startsWith('pdfjs/cmaps/'));
      const version = Date.now().toString(36);
      const swPath = join(dist, 'sw.js');
      const sw = readFileSync(swPath, 'utf8')
        .replace('self.__PRECACHE = []', `self.__PRECACHE = ${JSON.stringify(['./', ...list])}`)
        .replace("self.__VERSION = 'dev'", `self.__VERSION = '${version}'`);
      writeFileSync(swPath, sw);
    },
  };
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Relative base so the same build works on a web host, inside Electron and inside Capacitor.
  base: './',
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  plugins: [precacheManifest()],
});
