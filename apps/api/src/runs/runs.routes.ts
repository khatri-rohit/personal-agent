import { Router, type Request, type Response } from 'express';
import { API_ROUTES } from '@agent/agent-models';
import type { AgentService } from '@agent/agent-service';
import type { AgentEvent } from '@agent/agent-models';
import { parseStartRunRequest } from '@agent/agent-models';


import { asyncRoute } from '../platform/http-errors';
import { estimateContext, startThreadRun } from '@agent/agent-service';

export function runsRouter(service: AgentService): Router {
  const router = Router();

  /**
   * POST /api/agent/run
   * Append optional user turn to the host ledger, then start a run.
   */
  router.post(API_ROUTES['runs.start'].path, asyncRoute(async (req: Request, res: Response) => {
    const request = parseStartRunRequest(req.body);
    if (typeof request === 'string') return res.status(400).json({ error: request });
    const result = await startThreadRun(service, request);
    if (result.ok) return res.json({ runId: result.runId, ...(result.restore ? { restore: result.restore } : {}) });
    return res.status(REJECTION_STATUS[result.reason]).json({
      error: result.error,
      ...(result.runId !== undefined ? { runId: result.runId } : {}),
    });
  }));

  const REJECTION_STATUS = { invalid: 400, not_found: 404, busy: 409, paused: 429 } as const;

  /**
   * POST /api/agent/context/estimate
   * Same assembler as /run: host ledger + memory files + optional draft.
   */
  router.post(API_ROUTES['runs.estimate'].path, asyncRoute(async (req: Request, res: Response) => {
    return res.json(await estimateContext(service, req.body));
  }));

  /**
   * POST /api/agent/run/:runId/cancel
   * Stop an in-flight run. `finishing`: the answer is already saved and only
   * post-run work is left, so nothing is cancelled; wait for run.settled.
   */
  router.post(API_ROUTES['runs.cancel'].path, (req: Request, res: Response) => {
    const result = service.runs.cancel(req.params.runId);
    if (result === 'not_found') {
      return res.status(404).json({ error: 'Run not found or not active' });
    }
    return res.json({ ok: true, ...(result === 'finishing' ? { finishing: true } : {}) });
  });

  function parseChoiceOptionIds(value: unknown): string[] | null {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return null;
    const ids: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string' || !item.trim()) return null;
      ids.push(item.trim());
    }
    return ids;
  }

  /**
   * POST /api/agent/run/:runId/choice
   * Continue with selected options + extra text, or skip (the run ends with a summary of the options).
   */
  router.post(API_ROUTES['runs.choice'].path, (req: Request, res: Response) => {
    const { runId } = req.params;
    const body = req.body as {
      choiceId?: unknown;
      skipped?: unknown;
      optionIds?: unknown;
      text?: unknown;
    };
    const choiceId =
      typeof body.choiceId === 'string' ? body.choiceId.trim() : '';
    if (!choiceId) {
      return res.status(400).json({ error: 'choiceId is required' });
    }

    if (body.skipped === true) {
      const skipped = service.runs.resolveChoice(runId, choiceId, {
        skipped: true,
      });
      if (skipped !== 'ok') {
        return res.status(404).json({
          error: 'Choice not found or already resolved',
        });
      }
      return res.json({ ok: true });
    }

    const optionIds = parseChoiceOptionIds(body.optionIds);
    if (optionIds === null) {
      return res.status(400).json({ error: 'optionIds must be a string array' });
    }
    const result = service.runs.resolveChoice(runId, choiceId, {
      optionIds,
      ...(typeof body.text === 'string' ? { text: body.text } : {}),
    });

    if (result === 'invalid') {
      return res.status(400).json({
        error:
          'Select at least one option or enter text, with matching option ids',
      });
    }
    if (result !== 'ok') {
      return res.status(404).json({
        error: 'Choice not found or already resolved',
      });
    }
    return res.json({ ok: true });
  });

  /**
   * GET /api/agent/run/:runId/events?fromSeq=N
   * SSE stream of AgentEvents for a run: replays buffered events after fromSeq,
   * then streams live ones. The response ends with run.settled, or with
   * `event: done` for a run already settled.
   */
  router.get(API_ROUTES['runs.events'].path, (req: Request, res: Response) => {
    const fromSeq = Number(req.query.fromSeq ?? 0);
    let ended = false;
    const send = (event: AgentEvent) => {
      if (ended) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'run.settled') end();
    };
    const subscription = service.runs.subscribe(req.params.runId, fromSeq, send);
    if (!subscription) {
      return res.status(404).json({ error: 'Run not found' });
    }
    function end() {
      if (ended) return;
      ended = true;
      subscription?.unsubscribe();
      res.end();
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Flush headers immediately.
    res.write(': connected\n\n');
    for (const event of subscription.replay) send(event);
    if (!subscription.live) {
      if (!ended) res.write('event: done\ndata: {}\n\n');
      end();
      return;
    }
    req.on('close', end);
    return;
  });

  return router;
}
