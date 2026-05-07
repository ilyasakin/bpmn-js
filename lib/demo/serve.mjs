#!/usr/bin/env node
/**
 * Vite-based dev server for the bpmn-xyflow demos.
 *
 *   /         vanilla viewer
 *   /modeler  full editor
 *   /react    React wrapper
 *   /vue      Vue wrapper
 *   /svelte   Svelte wrapper
 *
 * Run: node lib/demo/serve.mjs   (or `pnpm start` / `pnpm dev`)
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import vue from '@vitejs/plugin-vue';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const fixturesRoot = path.join(repoRoot, 'test/fixtures/bpmn');

const PORT = Number(process.env.PORT) || 5173;

function dirRedirectPlugin() {
  // Vite doesn't redirect /modeler -> /modeler/, so HTML lookup falls
  // through to module-style resolution. Force a 308 for bare dir paths.
  const dirs = [ 'modeler', 'react', 'vue', 'svelte' ];
  return {
    name: 'bpmn-dir-redirect',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        for (const d of dirs) {
          if (url === '/' + d) {
            res.statusCode = 308;
            res.setHeader('Location', '/' + d + '/');
            return res.end();
          }
        }
        next();
      });
    }
  };
}

function fixturesPlugin() {
  return {
    name: 'bpmn-fixtures',
    configureServer(server) {
      server.middlewares.use('/test/fixtures/bpmn', async (req, res, next) => {
        const rel = (req.url || '').split('?')[0];
        if (!rel || rel === '/') return next();
        const filePath = path.join(fixturesRoot, rel);
        if (!filePath.startsWith(fixturesRoot)) {
          res.statusCode = 403;
          return res.end('forbidden');
        }
        if (!existsSync(filePath)) {
          res.statusCode = 404;
          return res.end('not found');
        }
        try {
          const data = await fs.readFile(filePath);
          const ext = path.extname(filePath).toLowerCase();
          res.setHeader('Content-Type',
            ext === '.bpmn' || ext === '.xml'
              ? 'application/xml; charset=utf-8'
              : 'application/octet-stream'
          );
          res.end(data);
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    }
  };
}

const server = await createServer({
  configFile: false,
  root: __dirname,
  cacheDir: path.join(__dirname, '.cache', 'vite'),
  optimizeDeps: {
    exclude: [ 'svelte' ]
  },
  server: {
    port: PORT,
    strictPort: false,
    fs: { allow: [ repoRoot ] }
  },
  plugins: [
    dirRedirectPlugin(),
    react({ include: /\.(jsx|tsx)$/ }),
    vue(),
    svelte({ compilerOptions: { dev: true } }),
    fixturesPlugin()
  ]
});

await server.listen();
const info = server.config.server;
const port = server.httpServer?.address()?.port ?? info.port;

console.log(`bpmn-xyflow demo listening on http://localhost:${ port }`);
console.log(`  vanilla: http://localhost:${ port }/`);
console.log(`  modeler: http://localhost:${ port }/modeler/`);
console.log(`  react:   http://localhost:${ port }/react/`);
console.log(`  vue:     http://localhost:${ port }/vue/`);
console.log(`  svelte:  http://localhost:${ port }/svelte/`);
