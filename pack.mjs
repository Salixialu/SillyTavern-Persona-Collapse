/**
 * pack.mjs — persona-collapse 插件打包脚本
 * 用法: pnpm zip
 * 输出: persona-collapse-v{version}.zip 到项目根目录
 *
 * zip 内部结构（解压到 third-party/ 后即可使用）：
 *   persona-collapse/
 *   ├─ manifest.json
 *   └─ dist/
 *      ├─ index.js
 *      └─ style.css
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const ROOT = import.meta.dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf-8'));
const version = manifest.version ?? '0.0.0';
const outName = `persona-collapse.zip`;

// 输出到 releases/ 目录，方便集中查找历史版本
const releasesDir = path.join(ROOT, 'releases');
if (!fs.existsSync(releasesDir)) fs.mkdirSync(releasesDir);
const outPath = path.join(releasesDir, outName);

// 检查构建产物
if (!fs.existsSync(path.join(ROOT, 'dist', 'index.js'))) {
  console.error('❌ dist/index.js 不存在，请先运行 pnpm build');
  process.exit(1);
}

// 确保 dist/style.css 存在
if (!fs.existsSync(path.join(ROOT, 'dist', 'style.css'))) {
  fs.copyFileSync(path.join(ROOT, 'style.css'), path.join(ROOT, 'dist', 'style.css'));
  console.log('📋 已将 style.css 复制到 dist/');
}

// 删除旧 zip
if (fs.existsSync(outPath)) {
  fs.unlinkSync(outPath);
  console.log(`🗑  已删除旧的 ${outName}`);
}

// 创建临时目录，按 ST 期望的目录结构放置文件
// 结构：tmp/persona-collapse/dist/index.js 等
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-collapse-'));
const pluginDir = path.join(tmpDir, 'persona-collapse');
const distDir = path.join(pluginDir, 'dist');

try {
  fs.mkdirSync(distDir, { recursive: true });

  // 复制文件到临时目录
  fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(pluginDir, 'manifest.json'));
  fs.copyFileSync(path.join(ROOT, 'dist', 'index.js'), path.join(distDir, 'index.js'));
  fs.copyFileSync(path.join(ROOT, 'dist', 'style.css'), path.join(distDir, 'style.css'));

  // 压缩临时目录（保留 persona-collapse/ 顶级目录结构）
  const cmd = `powershell -NoProfile -Command "Compress-Archive -Path '${pluginDir}' -DestinationPath '${outPath}'"`;
  execSync(cmd, { stdio: 'inherit' });

  const size = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`\n✅ 打包完成: ${outName} (${size} KB)`);
  console.log(`📦 路径: ${outPath}`);
  console.log(`\n部署方法：`);
  console.log(`  将 zip 解压到 SillyTavern/public/scripts/extensions/third-party/`);
  console.log(`  ⚠  解压后应为：third-party/persona-collapse/dist/index.js`);
} finally {
  // 清理临时目录
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
