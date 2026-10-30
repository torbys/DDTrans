const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const prepareScript = path.join(root, 'scripts', 'prepare-virtual-audio.ps1');
const payload = path.join(root, 'data', 'virtual-audio', 'build');
const requiredPayloadEntries = [
  'ddtrans-audio-device.exe',
  'ddtrans-audio-probe.exe',
  'vendor',
  'VBCABLE_Driver_Pack45.zip',
  'THIRD-PARTY-NOTICES.txt',
  'vendor-license.html',
  'manifest.json',
];
const supportedArguments = new Set(['--dir']);
const requestedArguments = process.argv.slice(2);

if (requestedArguments.some(argument => !supportedArguments.has(argument))) {
  throw new Error('Supported arguments: --dir');
}

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with code ${result.status ?? 1}.`);
}

if (!fs.existsSync(prepareScript)) {
  throw new Error('Missing scripts/prepare-virtual-audio.ps1. Build the immutable virtual-audio payload before packaging.');
}

run('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', prepareScript]);

const missingPayloadEntries = requiredPayloadEntries.filter(entry => !fs.existsSync(path.join(payload, entry)));
if (missingPayloadEntries.length > 0) {
  throw new Error(`Prepared virtual-audio payload is incomplete: ${missingPayloadEntries.join(', ')}`);
}

const builder = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(builder)) throw new Error('Missing local electron-builder dependency. Run npm ci first.');

const builderArguments = requestedArguments.includes('--dir')
  ? ['--win', '--x64', '--dir']
  : ['--win', 'nsis', '--x64'];
const output = path.join(root, 'release');
fs.mkdirSync(output, { recursive: true });
const builderTemp = fs.mkdtempSync(path.join(output, 'ddtrans-package-'));
const builderCache = path.join(builderTemp, 'electron-builder-cache');
try {
  run(process.execPath, [builder, ...builderArguments], {
    ...process.env,
    ELECTRON_BUILDER_CACHE: builderCache,
    TEMP: builderTemp,
    TMP: builderTemp,
  });
} finally {
  const actualOutput = fs.realpathSync(output);
  const actualTemp = fs.realpathSync(builderTemp);
  const relativeTemp = path.relative(actualOutput, actualTemp);
  if (!relativeTemp || path.isAbsolute(relativeTemp) || relativeTemp === '..' || relativeTemp.startsWith('..' + path.sep) || !path.basename(actualTemp).startsWith('ddtrans-package-')) {
    throw new Error('Refusing to remove a temporary directory outside the release output.');
  }
  fs.rmSync(actualTemp, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
}
