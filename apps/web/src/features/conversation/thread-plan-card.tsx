'use client';

import { Check, Circle, CircleDot, ListTodo } from 'lucide-react';
import {
  isThreadPlanEmpty,
  planScopedTodos,
  planTodoCounts,
  type ThreadPlan,
} from '@agent/agent-models';
import { TrailLine, TrailSection } from './trail-line';
import { cn } from '@/lib/utils';

/** One-line progress for the live dock: "Plan 3/7" / "Planning". */
export function planProgressLabel(plan: ThreadPlan | null): string | null {
  if (!plan || isThreadPlanEmpty(plan)) return null;
  const counts = planTodoCounts(plan);
  if (plan.todos.length > 0) {
    return `Plan ${counts.completed}/${plan.todos.length}`;
  }
  return plan.final?.trim() ? 'Plan ready' : 'Planning';
}

/**
 * Settled plan in the reading flow, under the user message that anchored
 * it: one trail line ("3 of 7 to-dos done"), expanding in place.
 */
export function PlanChip({ plan }: { plan: ThreadPlan | null }) {
  if (!plan || isThreadPlanEmpty(plan)) return null;

  const counts = planTodoCounts(plan);
  const allDone =
    plan.todos.length > 0 && counts.completed === plan.todos.length;
  const label =
    plan.todos.length > 0
      ? allDone
        ? `All ${plan.todos.length} to-dos done`
        : `${counts.completed} of ${plan.todos.length} to-dos done`
      : 'Plan finalized';

  return (
    <TrailLine
      icon={
        allDone ? (
          <Check className="size-3.5" strokeWidth={2} />
        ) : (
          <ListTodo className="size-3.5" strokeWidth={1.75} />
        )
      }
      label={label}
      ariaLabel="Plan"
    >
      <PlanDetail plan={plan} />
    </TrailLine>
  );
}

/** Goal, decisions, final plan or journal, and to-dos — shared by chip and dock. */
export function PlanDetail({ plan }: { plan: ThreadPlan }) {
  return (
    <div className="min-w-0 space-y-1">
      {plan.goal.trim() ? (
        <p className="type-ui leading-relaxed text-[var(--reading-foreground)]">
          {plan.goal}
        </p>
      ) : null}
      {plan.decisions.length > 0 ? (
        <TrailSection title="Decisions">
          <ul className="space-y-0.5">
            {plan.decisions.map((decision) => (
              <li
                key={decision.id}
                className="type-ui leading-relaxed text-[var(--reading-foreground)]"
              >
                {decision.text}
              </li>
            ))}
          </ul>
        </TrailSection>
      ) : null}
      {plan.final?.trim() ? (
        <TrailSection title="Final plan">
          <pre className="type-ui max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans leading-relaxed text-[var(--reading-foreground)]">
            {plan.final}
          </pre>
        </TrailSection>
      ) : plan.notes.length > 0 ? (
        <TrailSection title="Journal">
          <ul className="space-y-0.5">
            {plan.notes.slice(-6).map((note) => (
              <li
                key={note.id}
                className="type-ui leading-relaxed text-[var(--reading-foreground)]"
              >
                <span className="text-subtle-foreground">{note.kind}: </span>
                {note.text}
              </li>
            ))}
          </ul>
        </TrailSection>
      ) : null}
      <TodoList plan={plan} />
    </div>
  );
}

/** The scope's label when one is recorded on the plan, else null. */
function scopeLabel(plan: ThreadPlan): string | null {
  if (!planScopedTodos(plan)) return null;
  return plan.scope?.label.trim() || 'selected items';
}

/**
 * The plan's todos. With a scope recorded (what the user's current request
 * covers), the todos outside it are dimmed: the run works on, and is held
 * to, only the ones in scope.
 */
function TodoList({ plan }: { plan: ThreadPlan }) {
  if (plan.todos.length === 0) return null;
  const scoped = planScopedTodos(plan);
  const inScope = new Set((scoped ?? []).map((todo) => todo.id));
  const label = scopeLabel(plan);
  return (
    <TrailSection title={`To-dos${label ? ` · scope: ${label}` : ''}`}>
      <ul className="space-y-1">
        {plan.todos.map((todo) => (
          <li
            key={todo.id}
            className={cn(
              'type-ui flex items-start gap-2 leading-relaxed',
              scoped && !inScope.has(todo.id) && 'opacity-50',
            )}
          >
            <TodoMark status={todo.status} />
            <span
              className={cn(
                'min-w-0 flex-1 text-[var(--reading-foreground)]',
                todo.status === 'completed' &&
                  'text-subtle-foreground line-through',
              )}
            >
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </TrailSection>
  );
}

/** Still marks only: the dock's spinner is the run's one moving thing. */
function TodoMark({
  status,
}: {
  status: ThreadPlan['todos'][number]['status'];
}) {
  if (status === 'completed') {
    return <Check className="mt-1 size-3.5 shrink-0 text-subtle-foreground" />;
  }
  if (status === 'in_progress') {
    return (
      <CircleDot className="mt-1 size-3.5 shrink-0 text-foreground/80" />
    );
  }
  return <Circle className="mt-1 size-3.5 shrink-0 text-subtle-foreground" />;
}
