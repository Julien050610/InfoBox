import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function processInbox(library, onResult = () => {}) {
  await library.init({ watchInbox: false });
  const files = await library.inboxFiles();
  const skipped = files.filter(file => !file.supported).map(file => file.name);
  const results = [];
  for (const file of files.filter(value => value.supported)) {
    let job;
    if (file.inbox_kind === 'note') {
      job = await library.enqueueTemporaryNote(file.note_id);
    } else {
      let originalName = null;
      if (file.extension === '.url') {
        const raw = (await readFile(join(library.inbox, file.name), 'utf8')).trim();
        originalName = (raw.match(/^URL=(.+)$/im)?.[1] || raw).trim();
      }
      job = await library.enqueue(join(library.inbox, file.name), originalName);
    }
    if (!job) continue;
    await library.chain;
    const finished = await library.getJob(job.id);
    results.push(finished);
    onResult(finished);
  }
  return { results, skipped };
}
