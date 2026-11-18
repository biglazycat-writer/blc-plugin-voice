#!/usr/bin/env node
// 生成桌面端可直接安装的插件包（.tgz）。
// 关键约束：桌面端解压时只剥离 "package/" 前缀，并要求 package.json 位于解压根目录。
// npm pack 会强制排除 package-lock.json，而宿主准备依赖时需要它，
// 因此这里按 package.json 的 files 字段自行组装 package/ 目录再打包。
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';

const outDir = 'dist-package';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// Windows 上 Node 不能直接 spawn npm.cmd；优先用 npm 注入的 npm_execpath。
const npmCli = process.env.npm_execpath;
const runNpm = (args, options = {}) =>
  npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], options)
    : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        ...options,
        shell: process.platform === 'win32',
      });

console.log(`▶ 构建 ${pkg.name}@${pkg.version}`);
runNpm(['run', 'build'], {stdio: 'inherit'});

if (!existsSync('dist/main.js')) {
  console.error('✗ 构建产物缺失：dist/main.js');
  process.exit(1);
}

const stage = join(outDir, 'package');
rmSync(stage, {recursive: true, force: true});
mkdirSync(stage, {recursive: true});

for (const entry of pkg.files ?? []) {
  if (!existsSync(entry)) {
    console.error(`✗ package.json 的 files 声明了不存在的路径：${entry}`);
    process.exit(1);
  }
  cpSync(entry, join(stage, entry), {recursive: true});
}
cpSync('package.json', join(stage, 'package.json'));

if (!existsSync(join(stage, 'package-lock.json'))) {
  console.error('✗ 缺少 package-lock.json；宿主准备依赖需要它，请加入 package.json 的 files');
  process.exit(1);
}

const slug = pkg.name.replace(/^@/, '').replace(/\//g, '-');
const archive = join(outDir, `${slug}-${pkg.version}.tgz`);
console.log('▶ 生成插件包');
execFileSync('tar', ['-czf', archive, '-C', outDir, 'package'], {stdio: 'inherit'});

const entries = execFileSync('tar', ['-tzf', archive], {encoding: 'utf8'})
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);

const offenders = entries.filter(entry => entry !== 'package/' && !entry.startsWith('package/'));
if (offenders.length > 0) {
  console.error('✗ 归档顶层必须是 package/，以下条目不符合：');
  for (const entry of offenders.slice(0, 5)) console.error('   ', entry);
  process.exit(1);
}
for (const required of ['package/package.json', 'package/package-lock.json']) {
  if (!entries.includes(required)) {
    console.error(`✗ 归档缺少 ${required}`);
    process.exit(1);
  }
}

rmSync(stage, {recursive: true, force: true});

const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${sha}  ${basename(archive)}\n`);

console.log(`✓ ${basename(archive)}（${entries.length} 个条目）`);
console.log('✓ 结构校验通过：顶层 package/，含 package.json 与 package-lock.json');
console.log(`✓ SHA-256 ${sha}`);
console.log('');
console.log('桌面端「安装插件 → 插件包 (.zip / .tgz)」选择该文件，并勾选「准备依赖、类型检查并构建」。');
