#!/usr/bin/env node
/**
 * Tiny dev server for the xyflow read-only viewer demos.
 *
 * - serves lib/xyflow/demo/index.html at /                  (vanilla JS demo)
 * - bundles lib/xyflow/demo/index.js     at /demo.bundle.js
 * - serves lib/xyflow/demo/react/index.html at /react       (React demo)
 * - bundles lib/xyflow/demo/react/index.jsx at /react/demo.bundle.js
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

const builds = new Map();

function buildBundle(key, config) {
  if (builds.has(key)) return builds.get(key);

  const compiler = webpack(config);

  const promise = new Promise((resolve, reject) => {
    compiler.run((err, stats) => {
      compiler.close(() => {});
      if (err) return reject(err);
      if (stats.hasErrors()) {
        const info = stats.toJson({ errors: true });
        return reject(new Error(info.errors.map(e => e.message || e).join('\n')));
      }
      const file = path.join(config.output.path, config.output.filename);
      fs.readFile(file, 'utf8').then(resolve, reject);
    });
  });

  builds.set(key, promise);
  return promise;
}

function vanillaConfig() {
  return {
    mode: 'development',
    entry: path.join(__dirname, 'index.js'),
    output: {
      filename: 'demo.bundle.js',
      path: path.join(__dirname, '.cache', 'vanilla'),
      libraryTarget: 'umd'
    },
    devtool: 'inline-source-map',
    resolve: { extensions: [ '.js', '.mjs' ] }
  };
}

function modelerConfig() {
  return {
    mode: 'development',
    entry: path.join(__dirname, 'modeler', 'index.js'),
    output: {
      filename: 'demo.bundle.js',
      path: path.join(__dirname, '.cache', 'modeler'),
      libraryTarget: 'umd'
    },
    devtool: 'inline-source-map',
    resolve: { extensions: [ '.js', '.mjs' ] }
  };
}

function reactConfig() {
  return {
    mode: 'development',
    entry: path.join(__dirname, 'react', 'index.jsx'),
    output: {
      filename: 'demo.bundle.js',
      path: path.join(__dirname, '.cache', 'react'),
      libraryTarget: 'umd'
    },
    devtool: 'inline-source-map',
    resolve: { extensions: [ '.jsx', '.js', '.mjs' ] },
    module: {
      rules: [
        {
          test: /\.jsx?$/,
          exclude: /node_modules/,
          use: {
            loader: require.resolve('babel-loader'),
            options: {
              presets: [
                require.resolve('@babel/preset-env'),
                [ require.resolve('@babel/preset-react'), { runtime: 'classic' } ]
              ]
            }
          }
        }
      ]
    }
  };
}

function vueConfig() {
  return {
    mode: 'development',
    entry: path.join(__dirname, 'vue', 'index.js'),
    output: {
      filename: 'demo.bundle.js',
      path: path.join(__dirname, '.cache', 'vue'),
      libraryTarget: 'umd'
    },
    devtool: 'inline-source-map',
    resolve: {
      extensions: [ '.js', '.mjs' ],
      alias: {
        // ensure the runtime+compiler build so we can use h(), defineComponent, etc.
        vue: 'vue/dist/vue.esm-bundler.js'
      }
    }
  };
}

function svelteConfig() {
  return {
    mode: 'development',
    entry: path.join(__dirname, 'svelte', 'index.js'),
    output: {
      filename: 'demo.bundle.js',
      path: path.join(__dirname, '.cache', 'svelte'),
      libraryTarget: 'umd'
    },
    devtool: 'inline-source-map',
    resolve: {
      extensions: [ '.mjs', '.js', '.svelte' ],
      conditionNames: [ 'svelte', 'browser', 'import' ],
      mainFields: [ 'svelte', 'browser', 'module', 'main' ]
    },
    module: {
      rules: [
        {
          test: /\.svelte$/,
          use: {
            loader: require.resolve('svelte-loader'),
            options: {
              compilerOptions: { dev: true },
              emitCss: false
            }
          }
        },
        {
          test: /node_modules\/svelte\/.*\.mjs$/,
          resolve: { fullySpecified: false }
        }
      ]
    }
  };
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
      const text = await buildBundle('vanilla', vanillaConfig());
      return send(res, 200, text, MIME['.js']);
    }

    if (url === '/react' || url === '/react/' || url === '/react/index.html') {
      const html = await fs.readFile(path.join(__dirname, 'react', 'index.html'));
      return send(res, 200, html, MIME['.html']);
    }

    if (url === '/react/demo.bundle.js') {
      const text = await buildBundle('react', reactConfig());
      return send(res, 200, text, MIME['.js']);
    }

    if (url === '/vue' || url === '/vue/' || url === '/vue/index.html') {
      const html = await fs.readFile(path.join(__dirname, 'vue', 'index.html'));
      return send(res, 200, html, MIME['.html']);
    }

    if (url === '/vue/demo.bundle.js') {
      const text = await buildBundle('vue', vueConfig());
      return send(res, 200, text, MIME['.js']);
    }

    if (url === '/svelte' || url === '/svelte/' || url === '/svelte/index.html') {
      const html = await fs.readFile(path.join(__dirname, 'svelte', 'index.html'));
      return send(res, 200, html, MIME['.html']);
    }

    if (url === '/svelte/demo.bundle.js') {
      const text = await buildBundle('svelte', svelteConfig());
      return send(res, 200, text, MIME['.js']);
    }

    if (url === '/modeler' || url === '/modeler/' || url === '/modeler/index.html') {
      const html = await fs.readFile(path.join(__dirname, 'modeler', 'index.html'));
      return send(res, 200, html, MIME['.html']);
    }

    if (url === '/modeler/demo.bundle.js') {
      const text = await buildBundle('modeler', modelerConfig());
      return send(res, 200, text, MIME['.js']);
    }

    if (url.startsWith('/test/fixtures/bpmn/')) {
      const rel = url.replace(/^\//, '');
      const filePath = path.join(repoRoot, rel);
      if (!filePath.startsWith(repoRoot)) return send(res, 403, 'forbidden');
      if (!existsSync(filePath)) return send(res, 404, 'not found');
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
  console.log(`  vanilla: http://localhost:${ PORT }/`);
  console.log(`  react:   http://localhost:${ PORT }/react`);
  console.log(`  vue:     http://localhost:${ PORT }/vue`);
  console.log(`  svelte:  http://localhost:${ PORT }/svelte`);
  console.log(`  modeler: http://localhost:${ PORT }/modeler`);
});
