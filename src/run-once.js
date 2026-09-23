import { readdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Library } from './library.js';
import { getGenerationConfiguration } from './models.js';

const SUPPORTED = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.url', '.webloc']);

export async function processInbox(library, onResult = () => {}) {
  await library.init({ watchInbox: false });
  const entries = await readdir(library.inbox, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && SUPPORTED.has(extname(entry.name).toLowerCase()));
  const skipped = entries.filter(entry => entry.isFile() && !entry.name.startsWith('.') && !entry.name.endsWith('.partial') && !SUPPORTED.has(extname(entry.name).toLowerCase())).map(entry => entry.name);
  const results = [];
  for (const entry of files) {
    const job = await library.enqueue(join(library.inbox, entry.name));
    if (!job) continue;
    await library.chain;
    const finished = await library.getJob(job.id);
    results.push(finished);
    onResult(finished);
  }
  return { results, skipped };
}

async function main() {
  try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = getGenerationConfiguration();
  const library = new Library();
  console.log(`InfoBox：使用 ${config.provider} / ${config.model} 处理本次收件箱。`);
  try {
    const { results, skipped } = await processInbox(library, job => {
      console.log(`${job.status === 'ready' ? '已入库' : '待检查'}：${job.original_name}${job.error ? `（${job.error}）` : ''}`);
    });
    const ready = results.filter(job => job.status === 'ready').length;
    const review = results.filter(job => job.status === 'review').length;
    console.log(`处理完毕：已入库 ${ready} 项，待检查 ${review} 项。`);
    if (skipped.length) console.log(`未处理的文件类型：${skipped.join('、')}`);
    if (review) console.log(`待检查目录：${library.review}`);
    const report = [
      `运行时间：${new Date().toLocaleString('zh-CN')}`,
      `模型：${config.provider} / ${config.model}`,
      `结果：已入库 ${ready} 项，待检查 ${review} 项`,
      ...results.map(job => `${job.status === 'ready' ? '已入库' : '待检查'}：${job.original_name}${job.error ? `（${job.error}）` : ''}`),
      ...(skipped.length ? [`未处理的文件类型：${skipped.join('、')}`] : []),
      ...(review ? [`待检查目录：${library.review}`] : []),
    ];
    await writeFile(join(library.root, 'data', 'last-run.txt'), `${report.join('\n')}\n`);
  } finally {
    library.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
