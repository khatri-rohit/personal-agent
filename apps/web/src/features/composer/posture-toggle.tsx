'use client';

import type { RunPosture } from '@agent/agent-models';
import {
  Bot,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export const POSTURE_LABEL: Record<RunPosture, string> = {
  ask: 'Ask',
  plan: 'Plan',
  agent: 'Agent',
};

const POSTURE_ICON: Record<RunPosture, LucideIcon> = {
  ask: CircleHelp,
  plan: ClipboardList,
  agent: Bot,
};

const POSTURE_DESCRIPTION: Record<RunPosture, string> = {
  ask: 'Answer questions without changing files',
  plan: 'Explore and prepare a plan to approve',
  agent: 'Work with tools and make changes',
};

const ORDER: RunPosture[] = ['ask', 'plan', 'agent'];

/** Ctrl+, cycles Ask → Plan → Agent → Ask. */
export function nextPosture(current: RunPosture): RunPosture {
  return ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'agent';
}

/** Workspace Ask / Plan / Agent menu for the next send. Ask and Plan are read-only. */
export function PostureToggle({
  posture,
  onChange,
}: {
  posture: RunPosture;
  onChange: (posture: RunPosture) => void;
}) {
  const SelectedIcon = POSTURE_ICON[posture];

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 rounded-full bg-muted/45 px-2.5 text-xs font-normal text-muted-foreground ring-1 ring-border/35 hover:bg-muted/70 hover:text-foreground"
              aria-label={`Mode: ${POSTURE_LABEL[posture]}`}
            >
              <SelectedIcon className="size-3.5" aria-hidden />
              {POSTURE_LABEL[posture]}
              <ChevronDown className="size-3.5 opacity-70" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <span className="flex items-center gap-1.5">
            Cycle mode
            <Kbd>Ctrl</Kbd>
            <Kbd>,</Kbd>
          </span>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" className="w-64 bg-card shadow-lg">
        <DropdownMenuLabel>Mode for next message</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={posture}
          onValueChange={(value) => onChange(value as RunPosture)}
        >
          {ORDER.map((id) => {
            const Icon = POSTURE_ICON[id];
            return (
              <DropdownMenuRadioItem key={id} value={id} className="items-start py-2">
                <Icon className="mt-0.5 size-4" aria-hidden />
                <span className="min-w-0">
                  <span className="block font-medium">{POSTURE_LABEL[id]}</span>
                  <span className="type-caption block text-muted-foreground">
                    {POSTURE_DESCRIPTION[id]}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
