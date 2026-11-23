import path from 'node:path';

import {
  areaRows,
  flattenRuns,
  listRuns,
  loadRunMetrics,
  PASS_POW_K,
  passPow,
  readSuiteRun,
  wilsonInterval,
  type TrialResult,
} from '@agent/agent-eval';

import { evalHome } from '../../../lib/home';
import { tokens } from '../../../lib/format';

export const dynamic = 'force-dynamic';

/** The grade parts as dots: checks, files, answer, scope, budget. */
function GradeDots({ trial }: { trial: TrialResult }) {
  const parts: [string, boolean | undefined][] = [
    ['checks', trial.checksPassed],
    ['files', trial.filesPassed],
    ['answer', trial.answersPassed],
    ['scope', trial.scopeViolations ? trial.scopeViolations.length === 0 : undefined],
    ['budget', trial.budgetOk],
  ];
  return (
    <span className="dots">
      {parts.map(([label, ok]) => (
        <i key={label} title={`${label}: ${ok === undefined ? 'not graded' : ok ? 'ok' : 'failed'}`} className={ok === undefined ? 'dot' : ok ? 'dot ok' : 'dot bad'} />
      ))}
    </span>
  );
}

export default async function SuiteRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const home = evalHome();
  const suiteRun = await readSuiteRun(path.join(home, 'results', path.basename(decodeURIComponent(id))));
  const { meta, results } = suiteRun;
  const tasks = [...new Set(results.map((trial) => trial.taskId))];
  const maxTrial = Math.max(0, ...results.map((trial) => trial.trial));
  const runIds = new Set(results.flatMap((trial) => trial.runIds));
  // Only the trials' own threads (and their sub-agent threads), not every trace in the home.
  const threadIds = [...new Set(results.flatMap((trial) => (trial.threadId ? [trial.threadId] : [])))];
  const runs = flattenRuns((await Promise.all(threadIds.map((threadId) => listRuns(home, { threadId })))).flat()).filter(
    (run) => runIds.has(run.runId) || (run.parentRunId !== undefined && runIds.has(run.parentRunId)),
  );
  const areas = areaRows(await loadRunMetrics(home, runs)).filter((row) => row.runs > 0);
  const graded = results.filter((trial) => trial.status !== 'skipped');
  const failures = new Map<string, number>();
  for (const trial of graded) {
    if (trial.failure) failures.set(trial.failure, (failures.get(trial.failure) ?? 0) + 1);
  }
  const taskSummary = (task: string) => {
    const trials = graded.filter((trial) => trial.taskId === task);
    const passes = trials.filter((trial) => trial.status === 'passed').length;
    const [low, high] = wilsonInterval(passes, trials.length);
    const pow = passPow(passes, trials.length);
    return { passes, trials: trials.length, low, high, pow };
  };

  return (
    <>
      <p className="muted crumbs">
        <a href="/results">suite runs</a> / {meta?.label ?? suiteRun.id}
      </p>
      <h1>{meta?.label ?? suiteRun.id}</h1>
      <p className="muted">
        {meta ? `${meta.suite} · ${meta.model} · harness ${meta.harnessSha.slice(0, 8)}${meta.harnessDirty ? '+dirty' : ''} · seed ${meta.seedHash.slice(0, 8)}` : 'no meta file (older suite run)'}
        {meta?.stopped ? ` · stopped: ${meta.stopped}` : ''}
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th title={`Passes, 95% Wilson interval, and pass^${PASS_POW_K} (all ${PASS_POW_K} in a row pass)`}>Pass rate</th>
              {Array.from({ length: maxTrial }, (_, i) => (
                <th key={i}>Trial {i + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task}>
                <td>{task}</td>
                <td className="wrap">
                  {(() => {
                    const s = taskSummary(task);
                    return (
                      <>
                        {s.passes}/{s.trials}
                        <div className="muted small">
                          {Math.round(s.low * 100)}–{Math.round(s.high * 100)}%
                          {s.pow === null ? '' : ` · pass^${PASS_POW_K} ${Math.round(s.pow * 100)}%`}
                        </div>
                      </>
                    );
                  })()}
                </td>
                {Array.from({ length: maxTrial }, (_, i) => {
                  const trial = results.find((r) => r.taskId === task && r.trial === i + 1);
                  if (!trial) return <td key={i} className="muted">–</td>;
                  const lastRun = trial.runIds.at(-1);
                  return (
                    <td key={i} className="wrap">
                      <span className={`trial-${trial.status}`}>{trial.status}</span> <GradeDots trial={trial} />
                      {trial.failure ? <span className="chip sig-bad">{trial.failure}</span> : null}
                      <div className="muted small">
                        {trial.ended ?? ''} · {tokens(trial.promptTokens)} · {trial.minutes ?? '–'} min
                        {trial.continues ? ` · ${trial.continues} continue` : ''}
                      </div>
                      {trial.reason ? <div className="muted small">{trial.reason}</div> : null}
                      {lastRun ? (
                        <a className="small" href={`/runs/${lastRun}?home=eval`}>
                          open run →
                        </a>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Why trials failed</h2>
      {failures.size === 0 ? (
        <p className="muted">No failed or errored trial with a recorded cause (results from before failure categories have none).</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Cause</th>
              <th>Trials</th>
            </tr>
          </thead>
          <tbody>
            {[...failures.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([cause, count]) => (
                <tr key={cause}>
                  <td>{cause}</td>
                  <td>{count}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      <h2>Where the cost went</h2>
      {areas.length === 0 ? (
        <p className="muted">No area tripped a threshold.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Area</th>
              <th>Runs</th>
              <th>Tokens in those runs</th>
              <th>Worst signal</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {areas.map((row) => (
              <tr key={row.area}>
                <td>{row.area}</td>
                <td>{row.runs}</td>
                <td>{tokens(row.tokens)}</td>
                <td className="wrap">{row.worst ? `${row.worst.severity} · ${row.worst.signal}` : '–'}</td>
                <td className="wrap muted">{row.owner}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
