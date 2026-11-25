import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 说明：本机 Node 24 的 fs.rmSync 在这个工作区里会静默不删（已知环境问题），
// 所以用 readdir + unlink/rmdir 递归删除，确保旧 hash 资源不会被打进包。
function removeTree(target) {
  if (!existsSync(target)) return;
  const stat = lstatSync(target);
  if (!stat.isDirectory()) {
    unlinkSync(target);
    return;
  }
  for (const name of readdirSync(target)) removeTree(`${target}/${name}`);
  rmdirSync(target);
}

// Vite 的 emptyOutDir 在本项目里偶尔会保留旧 hash 资源；
// 构建前强制清空，避免旧 JS/.map 被打进安装包。
removeTree(fileURLToPath(new URL('../dist/', import.meta.url)));
