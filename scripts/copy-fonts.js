// Copies the IBM Plex font files from npm (@fontsource) into www/fonts so the app works offline.
const fs = require('fs'), path = require('path');
const out = path.join(__dirname, '..', 'www', 'fonts');
fs.mkdirSync(out, { recursive: true });
const want = { 'ibm-plex-sans': [400, 500, 600, 700], 'ibm-plex-mono': [400, 500, 600] };
let n = 0;
for (const [pkg, weights] of Object.entries(want)) {
  for (const w of weights) {
    const f = `${pkg}-latin-${w}-normal.woff2`;
    const src = path.join(__dirname, '..', 'node_modules', '@fontsource', pkg, 'files', f);
    if (!fs.existsSync(src)) { console.error('missing font file: ' + src); process.exitCode = 1; continue; }
    fs.copyFileSync(src, path.join(out, f)); n++;
  }
}
console.log(`copied ${n} font files to www/fonts`);

// pdf.js for reading lab report PDFs (served as .js so the Android WebView gives it a JavaScript MIME type)
const vendor = path.join(__dirname, '..', 'www', 'vendor');
fs.mkdirSync(vendor, { recursive: true });
for (const [src, dst] of [['pdf.min.mjs', 'pdf.min.js'], ['pdf.worker.min.mjs', 'pdf.worker.min.js']]) {
  const from = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', src);
  if (!fs.existsSync(from)) { console.error('missing ' + from); process.exitCode = 1; continue; }
  fs.copyFileSync(from, path.join(vendor, dst));
}
console.log('copied pdf.js to www/vendor');

// jsPDF + autotable for the doctor report
for (const [pkg, file, dst] of [['jspdf', 'dist/jspdf.umd.min.js', 'jspdf.umd.min.js'], ['jspdf-autotable', 'dist/jspdf.plugin.autotable.min.js', 'jspdf.plugin.autotable.min.js']]) {
  const from = path.join(__dirname, '..', 'node_modules', pkg, file);
  if (!fs.existsSync(from)) { console.error('missing ' + from); process.exitCode = 1; continue; }
  fs.copyFileSync(from, path.join(vendor, dst));
}
console.log('copied jsPDF to www/vendor');
