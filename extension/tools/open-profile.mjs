import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = path.join(root, '.chrome-profile');
const chromeExe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

spawn(
  chromeExe,
  ['--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'https://leetcode.cn/'],
  { stdio: 'ignore', detached: true },
).unref();

console.log('Chrome 已用开发 Profile 启动（窗口保持打开）。');
console.log('Profile:', profile);
console.log('登录完成后直接关闭窗口即可；下次自动化测试会复用这份登录态。');
console.log('注意：自动化测试启动前会强制关闭使用该 Profile 的 Chrome 进程，测试期间请勿在该窗口操作。');
