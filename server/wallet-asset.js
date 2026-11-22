import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let bundle;

export function walletBrowserAsset() {
  bundle ??= build({
    entryPoints: [fileURLToPath(new URL('../client/wallet.js', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false
  }).then(result => result.outputFiles[0].text);
  return bundle;
}
