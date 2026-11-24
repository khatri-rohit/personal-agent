'use client';

import { useCallback, useEffect, useState } from 'react';
import { Search, Trash2 } from 'lucide-react';
import {
  deleteUserSkill,
  fetchSkillCatalogs,
  type SkillCatalogItem,
  type SkillCatalogs,
} from '@/api/skills-client';
import { toastError } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SkillCreateForm } from './skill-create-form';
import { cn } from '@/lib/utils';

type Tab = 'catalog' | 'create';

const ADD_COMMAND = 'npx skills add owner/repo -g';

function matchesQuery(
  skill: { name: string; description: string },
  query: string,
) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    skill.name.toLowerCase().includes(q) ||
    skill.description.toLowerCase().includes(q)
  );
}

function CatalogSkeleton() {
  return (
    <div className="flex flex-col gap-2.5" aria-busy="true" aria-live="polite">
      <div className="h-9 w-full animate-pulse rounded-lg bg-muted" />
      <div className="h-14 w-full animate-pulse rounded-lg bg-muted" />
      <div className="h-14 w-full animate-pulse rounded-lg bg-muted" />
      <div className="h-14 w-4/5 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}

function OriginBadge({ skill }: { skill: SkillCatalogItem }) {
  if (skill.issue === 'invalid') {
    return (
      <Badge variant="outline" className="shrink-0 font-normal">
        Invalid
      </Badge>
    );
  }
  if (skill.issue === 'conflict') {
    return (
      <Badge variant="outline" className="shrink-0 font-normal">
        Shadowed
      </Badge>
    );
  }
  if (skill.source === 'builtin') {
    return (
      <Badge variant="secondary" className="shrink-0 font-normal">
        Built-in
      </Badge>
    );
  }
  if (skill.source === 'workspace') {
    return (
      <Badge variant="outline" className="shrink-0 font-normal">
        Workspace
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="shrink-0 font-normal">
      Yours
    </Badge>
  );
}

function CatalogRow({
  skill,
  expanded,
  onToggleExpand,
  action,
}: {
  skill: SkillCatalogItem;
  expanded: boolean;
  onToggleExpand: () => void;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 rounded-lg px-2 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-medium text-foreground">
            {skill.name}
          </p>
          <OriginBadge skill={skill} />
        </div>
        <button
          type="button"
          onClick={onToggleExpand}
          className="mt-1 block w-full text-left"
          aria-expanded={expanded}
        >
          <p
            className={cn(
              'type-ui leading-5 text-muted-foreground',
              expanded ? 'whitespace-pre-wrap' : 'line-clamp-2',
            )}
          >
            {skill.description || 'No description'}
          </p>
        </button>
        {skill.issue === 'invalid' ? (
          <p className="mt-1 text-xs text-[var(--warning-fg)]">
            Not loaded. Folder name must match the spec name, with a
            description.
          </p>
        ) : null}
        {skill.issue === 'conflict' ? (
          <p className="mt-1 text-xs text-[var(--warning-fg)]">
            Not loaded. This name is reserved or duplicated.
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-start gap-0.5 pt-0.5">{action}</div>
      ) : null}
    </li>
  );
}

function AddHint() {
  return (
    <p className="type-caption shrink-0 leading-4 text-muted-foreground">
      Add packs with{' '}
      <span className="font-mono text-foreground/80">{ADD_COMMAND}</span>, then
      reopen this panel. Type / in the composer to attach a loadable skill.
    </p>
  );
}

export function SkillsPanel({
  open,
  onOpenChange,
  threadId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId?: string;
}) {
  const [tab, setTab] = useState<Tab>('catalog');
  const [catalogs, setCatalogs] = useState<SkillCatalogs>({
    builtin: [],
    user: [],
    workspace: [],
  });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [confirmFolder, setConfirmFolder] = useState<string | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadCatalogs = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setCatalogs(await fetchSkillCatalogs(threadId));
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Could not load skills';
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    if (!open) return;
    setTab('catalog');
    setQuery('');
    setConfirmFolder(null);
    setExpanded(new Set());
    void loadCatalogs();
  }, [open, loadCatalogs]);

  const filteredBuiltin = catalogs.builtin.filter((skill) =>
    matchesQuery(skill, query),
  );
  const filteredUser = catalogs.user.filter((skill) =>
    matchesQuery(skill, query),
  );
  const filteredWorkspace = catalogs.workspace.filter((skill) =>
    matchesQuery(skill, query),
  );
  const catalogCount =
    catalogs.builtin.length + catalogs.user.length + catalogs.workspace.length;

  async function handleDelete(folder: string) {
    setDeletingFolder(folder);
    try {
      setCatalogs(await deleteUserSkill(folder));
      setConfirmFolder(null);
    } catch (error) {
      toastError(
        error instanceof Error ? error.message : 'Could not remove skill',
      );
    } finally {
      setDeletingFolder(null);
    }
  }

  function toggleExpand(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery('');
          setConfirmFolder(null);
          setExpanded(new Set());
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        className={cn(
          'grid max-h-[min(90dvh,44rem)] w-full grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0',
          tab === 'create' ? 'sm:max-w-3xl' : 'sm:max-w-xl',
        )}
        showCloseButton
      >
        <DialogHeader className="shrink-0 gap-1.5 border-b border-border/60 px-4 py-3.5 pr-12">
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription>
            Procedure packs the agent can load. Write your own, or add folders
            with <span className="font-mono text-xs">{ADD_COMMAND}</span>. Type
            / in the composer to attach a pack. The agent loads a body with{' '}
            <span className="font-mono text-xs">load_skill</span> when intent
            fits.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3 overflow-hidden px-4 pt-3 pb-3 [grid-row:2]">
          <div
            role="tablist"
            aria-label="Skill sections"
            className="flex shrink-0 items-center gap-1 rounded-lg bg-muted/60 p-1 text-xs"
          >
            <button
              type="button"
              role="tab"
              id="skills-tab-catalog"
              aria-controls="skills-panel-catalog"
              aria-selected={tab === 'catalog'}
              onClick={() => setTab('catalog')}
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 font-medium transition-colors',
                tab === 'catalog'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Catalog
              {!loading && !loadError ? (
                <span className="ml-1 text-muted-foreground">
                  · {catalogCount}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              role="tab"
              id="skills-tab-create"
              aria-controls="skills-panel-create"
              aria-selected={tab === 'create'}
              onClick={() => setTab('create')}
              className={cn(
                'flex-1 rounded-md px-2 py-1.5 font-medium transition-colors',
                tab === 'create'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Create your own
            </button>
          </div>

          {tab === 'catalog' ? (
            <div
              id="skills-panel-catalog"
              role="tabpanel"
              aria-labelledby="skills-tab-catalog"
              className="flex min-h-0 flex-1 flex-col gap-2"
            >
              {loading ? (
                <CatalogSkeleton />
              ) : loadError ? (
                <div className="rounded-lg border border-border px-3 py-4 text-sm">
                  <p className="text-foreground">Could not load the catalog.</p>
                  <p className="mt-1 text-muted-foreground">{loadError}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => void loadCatalogs()}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <>
                  <div className="relative shrink-0">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search by name or description"
                      aria-label="Search skills"
                      className="h-9 w-full rounded-lg border border-input bg-transparent py-1 pr-2.5 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                  </div>
                  <ScrollArea className="h-[min(48vh,22rem)] pr-2">
                    <div className="pb-1">
                      {filteredBuiltin.length === 0 &&
                      filteredUser.length === 0 &&
                      filteredWorkspace.length === 0 ? (
                        <div className="px-0.5 py-8 text-center">
                          <p className="text-sm text-muted-foreground">
                            {query
                              ? 'No skills match that search.'
                              : 'No skills in the catalog yet.'}
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {filteredWorkspace.length > 0 ? (
                            <section>
                              <h3 className="sticky top-0 z-10 bg-popover px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground">
                                This workspace · {filteredWorkspace.length}
                              </h3>
                              <ul className="space-y-0.5">
                                {filteredWorkspace.map((skill) => (
                                  <CatalogRow
                                    key={`workspace:${skill.folder}`}
                                    skill={skill}
                                    expanded={expanded.has(
                                      `workspace:${skill.folder}`,
                                    )}
                                    onToggleExpand={() =>
                                      toggleExpand(`workspace:${skill.folder}`)
                                    }
                                  />
                                ))}
                              </ul>
                            </section>
                          ) : null}
                          {filteredBuiltin.length > 0 ? (
                            <section>
                              <h3 className="sticky top-0 z-10 bg-popover px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground">
                                Built-in · {filteredBuiltin.length}
                              </h3>
                              <ul className="space-y-0.5">
                                {filteredBuiltin.map((skill) => (
                                  <CatalogRow
                                    key={`builtin:${skill.folder}`}
                                    skill={skill}
                                    expanded={expanded.has(
                                      `builtin:${skill.folder}`,
                                    )}
                                    onToggleExpand={() =>
                                      toggleExpand(`builtin:${skill.folder}`)
                                    }
                                  />
                                ))}
                              </ul>
                            </section>
                          ) : null}
                          <section>
                            <h3 className="sticky top-0 z-10 bg-popover px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                              Yours · {filteredUser.length}
                            </h3>
                            {filteredUser.length === 0 ? (
                              <div className="px-2 pb-3">
                                <p className="text-sm text-muted-foreground">
                                  {query
                                    ? 'No skills match that search.'
                                    : 'Nothing in your skills folders yet.'}
                                </p>
                              </div>
                            ) : (
                              <ul className="space-y-0.5">
                                {filteredUser.map((skill) => {
                                  const confirming =
                                    confirmFolder === skill.folder;
                                  return (
                                    <CatalogRow
                                      key={`user:${skill.folder}`}
                                      skill={skill}
                                      expanded={expanded.has(
                                        `user:${skill.folder}`,
                                      )}
                                      onToggleExpand={() =>
                                        toggleExpand(`user:${skill.folder}`)
                                      }
                                      action={
                                        confirming ? (
                                          <div className="flex flex-col items-stretch gap-1 sm:flex-row">
                                            <Button
                                              type="button"
                                              variant="ghost"
                                              size="sm"
                                              className="h-7 px-2 text-muted-foreground"
                                              onClick={() =>
                                                setConfirmFolder(null)
                                              }
                                            >
                                              Keep
                                            </Button>
                                            <Button
                                              type="button"
                                              variant="destructive"
                                              size="sm"
                                              className="h-7 px-2"
                                              disabled={
                                                deletingFolder === skill.folder
                                              }
                                              onClick={() =>
                                                void handleDelete(skill.folder)
                                              }
                                            >
                                              {deletingFolder === skill.folder
                                                ? 'Removing…'
                                                : 'Remove'}
                                            </Button>
                                          </div>
                                        ) : (
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            className="size-7 text-muted-foreground hover:text-destructive"
                                            aria-label={`Remove ${skill.name}`}
                                            onClick={() =>
                                              setConfirmFolder(skill.folder)
                                            }
                                          >
                                            <Trash2 className="size-3.5" />
                                          </Button>
                                        )
                                      }
                                    />
                                  );
                                })}
                              </ul>
                            )}
                          </section>
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                  <AddHint />
                </>
              )}
            </div>
          ) : (
            <div
              id="skills-panel-create"
              role="tabpanel"
              aria-labelledby="skills-tab-create"
              className="flex min-h-[min(60vh,28rem)] flex-1 flex-col"
            >
              <SkillCreateForm
                onCreated={(next) => {
                  setCatalogs(next);
                  setTab('catalog');
                }}
                onCancel={() => setTab('catalog')}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
