import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

const options = {
  entryPoints: [
    'src/service-worker.ts',
    'src/popup.ts',
    'src/content.ts',
  ],
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'chrome120',
  sourcemap: true,
  minify: !watch,
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('Watching for changes...')
} else {
  await esbuild.build(options)
  console.log('Build complete.')
}
