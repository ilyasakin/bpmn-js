#!/usr/bin/env node
/**
 * Tiny dev server for the xyflow read-only viewer demo.
 *
 * - serves lib/xyflow/demo/index.html at /
 * - bundles lib/xyflow/demo/index.js with webpack at /demo.bundle.js
 * - serves test/fixtures/bpmn at /test/fixtures/bpmn
 *
 * Run: node lib/xyflow/demo/serve.mjs
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const webpack = require('webpack');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const PORT = process.env.PORT || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.bpmn': 'application/xml; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.css':  'text/css; charset=utf-8'
};

let bundle = null;
let bundleStats = null;
let bundlePromise = null;

function buildBundle() {
  if (bundlePromise) return bundlePromise;

  const compiler = webpack({
    mode: 'development',
    entry: path.join(__dirname, 'index.js'),
    output: {
      filename: 'demo.bundle.js',
      path: path.join(__dirname, '.cache'),
      libraryTarget: 'umd'
    },
    devtool: 'inline-source-map',
    resolve: {
      extensions: [ '.js', '.mjs' ]
    }
  });

  bundlePromise = new Promise((resolve, reject) => {
    compiler.run((err, stats) => {
      compiler.close(() => {});
      if (err) {
        return reject(err);
      }
      if (stats.hasErrors()) {
        const info = stats.toJson({ errors: true });
        return reject(new Error(info.errors.map(e => e.message || e).join('\n')));
      }
      bundleStats = stats;
      const file = path.join(__dirname, '.cache', 'demo.bundle.js');
      fs.readFile(file, 'utf8').then(text => {
        bundle = text;
        resolve(text);
      }, reject);
    });
  });

  return bundlePromise;
}

function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  let url = (req.url || '/').split('?')[0];

  try {
    if (url === '/') {
      const html = await fs.readFile(path.join(__dirname, 'index.html'));
      return send(res, 200, html, MIME['.html']);
    }

    if (url === '/demo.bundle.js') {
      const text = await buildBundle();
      return send(res, 200, text, MIME['.js']);
    }

    if (url.startsWith('/test/fixtures/bpmn/')) {
      const rel = url.replace(/^\//, '');
      const filePath = path.join(repoRoot, rel);
      if (!filePath.startsWith(repoRoot)) {
        return send(res, 403, 'forbidden');
      }
      if (!existsSync(filePath)) {
        return send(res, 404, 'not found');
      }
      const ext = path.extname(filePath).toLowerCase();
      const data = await fs.readFile(filePath);
      return send(res, 200, data, MIME[ext] || 'application/octet-stream');
    }

    send(res, 404, 'not found');
  } catch (err) {
    console.error('request error', err);
    send(res, 500, String(err && err.stack || err));
  }
});

server.listen(PORT, () => {
  console.log(`bpmn-xyflow demo listening on http://localhost:${ PORT }`);
});
