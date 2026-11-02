// Copies pdf.js font data, character maps, image decoders (wasm) and colour profiles into public/pdfjs so PDFs render offline
// (no CDN). Runs automatically before "npm run dev" and "npm run build".
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const src = join('node_modules', 'pdfjs-dist');
const dest = join('public', 'pdfjs');

if (!existsSync(src)) {
  console.error('pdfjs-dist is not installed. Run "npm install" first.');
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
for (const dir of ['standard_fonts', 'cmaps', 'wasm', 'iccs']) {
  const from = join(src, dir);
  if (existsSync(from)) cpSync(from, join(dest, dir), { recursive: true });
}
