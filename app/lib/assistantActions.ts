import { api } from './api';
import type { JobsContextValue } from './jobs';

export async function executeCreateFolder(
  args: { prefix: string },
): Promise<{ ok: true; prefix: string } | { error: string }> {
  try {
    const { url } = await api.signUpload(args.prefix, 'application/x-directory');
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-directory' },
      body: '',
    });
    if (!res.ok) {
      return { error: `PUT failed: HTTP ${res.status}` };
    }
    return { ok: true, prefix: args.prefix };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'create_folder failed' };
  }
}

export async function executeMove(
  args:
    | { kind: 'file'; from: string; to: string }
    | { kind: 'folder'; fromPrefix: string; toPrefix: string },
  deps: { addJob: JobsContextValue['addJob'] },
): Promise<unknown> {
  if (args.kind === 'file') {
    return api.moveFile(args.from, args.to);
  }

  const res = await api.moveFolder(args.fromPrefix, args.toPrefix);
  await deps.addJob(res.jobId, { fromPrefix: args.fromPrefix, toPrefix: args.toPrefix });
  return {
    jobId: res.jobId,
    status: 'queued',
    note: 'Folder move is async. Progress is tracked in the Backup tab; this chat does not wait for it.',
  };
}
