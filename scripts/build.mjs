import * as esbuild from 'esbuild';
import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');
const e2e = process.argv.includes('--e2e');

/**
 * Content scripts cannot be ES modules -- Chrome injects them as classic
 * scripts. Everything else is loaded from a document or declared as a module
 * service worker, so ESM is fine and keeps the output readable.
 */
const bundles = [
  { entry: 'extension/sw/index.ts', out: 'sw.js', format: 'esm' },
  { entry: 'extension/offscreen/index.ts', out: 'offscreen.js', format: 'esm' },
  { entry: 'extension/popup/index.ts', out: 'popup.js', format: 'esm' },
  { entry: 'extension/app/index.ts', out: 'app.js', format: 'esm' },
  { entry: 'extension/content/index.ts', out: 'content.js', format: 'iife' },
];

const alias = {
  name: 'alias',
  setup(build) {
    build.onResolve({ filter: /^@core\// }, (args) => ({
      path: path.join(root, 'packages/core', args.path.slice('@core/'.length)) + '.ts',
    }));
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(root, 'extension/shared', args.path.slice('@shared/'.length)) + '.ts',
    }));
  },
};

async function buildAll() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const contexts = [];
  for (const b of bundles) {
    if (!existsSync(path.join(root, b.entry))) {
      console.warn(`  skip ${b.entry} (not written yet)`);
      continue;
    }
    const options = {
      entryPoints: [path.join(root, b.entry)],
      outfile: path.join(outdir, b.out),
      bundle: true,
      format: b.format,
      target: 'chrome120',
      platform: 'browser',
      sourcemap: dev ? 'inline' : false,
      minify: !dev,
      logLevel: 'info',
      plugins: [alias],
      define: { __DEV__: String(dev), __E2E__: String(e2e) },
    };
    if (watch) {
      const ctx = await esbuild.context(options);
      await ctx.watch();
      contexts.push(ctx);
    } else {
      await esbuild.build(options);
    }
  }

  await copyStatic();
  console.log(`\nBuilt to dist/${watch ? ' (watching)' : ''}`);
  return contexts;
}

async function copyStatic() {
  const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));

  if (e2e) {
    // Test-only: the fake-Meet harness (tests/harness/fake-meet) is served
    // from localhost so the E2E suite can drive the real content-script
    // adapter and region-detection code path against synthesized audio/
    // video, instead of mocking it out. This pattern must never appear in
    // the manifest actually shipped to users -- `npm run build` (no --e2e)
    // never takes this branch.
    const harnessOrigin = 'http://localhost:4173/*';
    manifest.host_permissions.push(harnessOrigin);
    manifest.content_scripts[0].matches.push(harnessOrigin);
  }

  await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  for (const html of ['offscreen', 'popup', 'app']) {
    const src = path.join(root, `extension/${html}/${html}.html`);
    if (existsSync(src)) await cp(src, path.join(outdir, `${html}.html`));
  }
  for (const css of ['popup', 'app']) {
    const src = path.join(root, `extension/${css}/${css}.css`);
    if (existsSync(src)) await cp(src, path.join(outdir, `${css}.css`));
  }
  const icons = path.join(root, 'extension/icons');
  if (existsSync(icons)) await cp(icons, path.join(outdir, 'icons'), { recursive: true });
}

await buildAll();
if (watch) await new Promise(() => {});
