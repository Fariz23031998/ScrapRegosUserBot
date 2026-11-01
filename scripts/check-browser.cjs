const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
}
walk(path.join(root, 'browser'));

const emit = process.argv.includes('--emit');
let failed = 0;
for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (rel.endsWith('.d.ts')) continue;
  const include = [rel];
  if (!rel.endsWith('admin-common.ts') && rel.startsWith('browser/bot-admin/')) {
    include.push('browser/bot-admin/globals.d.ts');
  }
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ES2022',
      moduleDetection: 'legacy',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      strict: true,
      noEmit: !emit,
      outDir: 'public',
      rootDir: 'browser',
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    files: include,
  };
  const configPath = path.join(root, 'tsconfig.browser.file.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.browser.file.json', '--pretty', 'false'], {
    cwd: root,
    encoding: 'utf8',
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const errors = output.split(/\n/).filter((line) => line.includes('error TS'));
  if (errors.length) {
    failed += 1;
    console.log(`\n${rel} (${errors.length})`);
    console.log(errors.slice(0, 12).join('\n'));
  }
}
console.log(failed ? `\n${failed} browser files still have errors` : '\nbrowser files typecheck');
process.exit(failed ? 1 : 0);
