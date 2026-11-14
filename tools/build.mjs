// Rebuild public/js/firebase.js after changing the Firebase SDK version:  cd tools && npm install && npm run build
import { build } from 'esbuild';
await build({ entryPoints: ['fb-entry.js'], bundle: true, format: 'iife', minify: true, target: 'es2022', outfile: '../public/js/firebase.js', legalComments: 'none' });
console.log('public/js/firebase.js built');
