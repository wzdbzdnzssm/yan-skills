import fs from 'node:fs';
import path from 'node:path';

// npm's Windows .cmd shims cannot be spawned without a shell. Resolve the
// installed package's declared executable and pass arguments directly to Node.
export function nodeCli(command, args, { platform = process.platform, env = process.env, cwd = process.cwd() } = {}) {
  if (platform !== 'win32' || command !== 'opencli') return { command, args };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  for (const entry of String(env[pathKey] ?? '').split(';').filter(Boolean)) {
    const dir = path.resolve(cwd, entry.replace(/^"|"$/g, ''));
    if (!fs.existsSync(path.join(dir, 'opencli.cmd'))) continue;
    const packageDir = path.join(dir, 'node_modules', '@jackwener', 'opencli');
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.opencli;
    if (typeof bin !== 'string') throw new Error('Installed opencli package has no opencli executable');
    const executable = path.resolve(packageDir, bin);
    const relative = path.relative(packageDir, executable);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(executable)) {
      throw new Error('Installed opencli executable is missing or outside its package');
    }
    return { command: process.execPath, args: [executable, ...args] };
  }
  throw new Error('opencli npm installation not found on PATH');
}
