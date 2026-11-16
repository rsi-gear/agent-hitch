import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, sep } from 'node:path';
import { assert, sourcePath } from './schema.mjs';
export async function fileHash(path, algorithm = 'sha256') {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'expected regular dataset file');
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return (algorithm === 'sha256' ? 'sha256:' : '') + hash.digest('hex');
}
export async function within(root, path) {
  const actual = await realpath(path), base = await realpath(root);
  assert(actual.startsWith(base + sep), 'path escapes its declared root'); return actual;
}
export async function treeManifest(directory) {
  const files = [];
  const visit = async prefix => {
    for (const name of (await readdir(join(directory, prefix))).sort()) {
      const path = prefix ? `${prefix}/${name}` : name, absolute = join(directory, path), info = await lstat(absolute);
      sourcePath(path); assert(!info.isSymbolicLink(), 'symlinks are not dataset inputs');
      if (info.isDirectory()) await visit(path);
      else { assert(info.size <= 1024 ** 3, 'input file exceeds the 1 GiB profile'); files.push({ path, digest: await fileHash(absolute), bytes: info.size }); }
    }
  };
  await visit(''); return files;
}
