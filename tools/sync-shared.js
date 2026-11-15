// Predeploy hook: copies the shared engine and core into the server and the web app, so both run the same logic.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
for (const f of ['engine.js', 'core.js', 'memdb.js']) {
  const src = path.join(root, 'shared', f);
  if (f !== 'memdb.js') fs.copyFileSync(src, path.join(root, 'functions', f));
  fs.copyFileSync(src, path.join(root, 'public', 'js', f));
}
console.log('shared/*.js copied to functions/ and public/js/');

// Crew data library: the CSV files in data/ are also served from the site (public/data/), so Settings › Demo can load them in one click.
const lib = [];
for (const dir of ['crew', 'crew-simulated', 'demo']) {
  const src = path.join(root, 'data', dir), dst = path.join(root, 'public', 'data', dir);
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.csv')).sort()) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
    const head = fs.readFileSync(path.join(src, f), 'utf8').split('\n')[1] || '';
    lib.push({ dir, file: f, who: (head.split(',')[1] || '').trim(), bytes: fs.statSync(path.join(src, f)).size });
  }
}
fs.writeFileSync(path.join(root, 'public', 'data', 'index.json'), JSON.stringify({ built: new Date().toISOString(), files: lib }, null, 1));
console.log('data/ copied to public/data/ (' + lib.length + ' CSV files)');
