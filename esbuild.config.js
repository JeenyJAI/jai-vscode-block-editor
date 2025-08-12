const esbuild = require('esbuild');

const production = process.argv.includes('--production');

async function main() {
  const context = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !production,
    minify: production,
    treeShaking: true,
  });

  if (process.argv.includes('--watch')) {
    await context.watch();
    console.log('Watching for changes...');
  } else {
    await context.rebuild();
    await context.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});