import { listRuns, readCatalog, stopLabel, type RunSummary } from '@agent/agent-eval';

import { homeFor } from '../lib/home';
import { tokens, when } from '../lib/format';
import { reviewHref } from '../review/href';
import { readReview } from '../review/store';

export const dynamic = 'force-dynamic';

export default async function ThreadsPage({
  searchParams,
}: {
  searchParams: Promise<{ home?: string; all?: string }>;
}) {
  const search = await searchParams;
  const { home, query } = homeFor(search.home);
  const showAll = search.all === '1';
  const runs = await listRuns(home);
  const byThread = new Map<string, RunSummary[]>();
  for (const run of runs) {
    byThread.set(run.threadId, [...(byThread.get(run.threadId) ?? []), run]);
  }
  // Threads with traces, newest first; ?all=1 lists threads whose traces were cleared too.
  const threads = readCatalog(home)
    .filter((thread) => !thread.parentThreadId && (showAll || byThread.has(thread.id)))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  const hidden = readCatalog(home).filter((thread) => !thread.parentThreadId && !byThread.has(thread.id)).length;
  const reviewByThread = new Map(
    await Promise.all(
      threads.map(async (thread) => [thread.id, await readReview(home, thread.id)] as const),
    ),
  );

  return (
    <>
      <h1>Threads</h1>
      <p className="muted">
        {home} · <a href={search.home === 'eval' ? '/' : '/?home=eval'}>{search.home === 'eval' ? 'personal home' : 'eval home'}</a>
        {hidden > 0 ? (
          <>
            {' · '}
            {showAll ? (
              <a href={`/${query}`}>hide {hidden} without traces</a>
            ) : (
              <a href={`/${query ? `${query}&` : '?'}all=1`}>show {hidden} without traces</a>
            )}
          </>
        ) : null}
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Thread</th>
              <th>Kind</th>
              <th>Model</th>
              <th>Runs</th>
              <th>Last run</th>
              <th>Prompt tokens</th>
              <th>Updated</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {threads.map((thread) => {
              const threadRuns = byThread.get(thread.id) ?? [];
              const last = threadRuns[0];
              const prompt = threadRuns.reduce(
                (sum, run) =>
                  sum + (run.usage?.own.promptTokens ?? 0) + (run.usage?.children.promptTokens ?? 0),
                0,
              );
              const reviewed = reviewByThread.get(thread.id);
              return (
                <tr key={thread.id}>
                  <td className="wrap">
                    <a href={`/threads/${thread.id}${query}`}>{thread.title || thread.id}</a>
                  </td>
                  <td>{thread.kind}</td>
                  <td>{thread.model}</td>
                  <td>{threadRuns.length}</td>
                  <td className={last ? `status-${last.status}` : 'muted'}>
                    {last ? `${last.status}${last.limitReason ? ` · ${stopLabel(last.limitReason)}` : ''}` : '–'}
                  </td>
                  <td>{tokens(prompt)}</td>
                  <td>{when(thread.updatedAt)}</td>
                  <td>
                    <a href={reviewHref(thread.id, { homeFlag: search.home === 'eval' ? 'eval' : '' })}>{reviewed ? 'Open review' : 'Review'}</a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
