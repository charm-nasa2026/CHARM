// Predeploy hook: copies the shared engine and core into the server and the web app, so both run the same logic.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
for (const f of ['engine.js', 'core.js', 'memdb.js']) {
  const src = path.join(root, 'shared', f);
  if (f !== 'memdb.js') fs.copyFileSync(src, path.join(root, 'functions', f));
  fs.copyFileSync(src, path.join(root, 'public', 'js', f));
}
console.log('shared/*.js copied to functions/ and public/js/');
