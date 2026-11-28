/**
 * agent-service: the host's state and run logic (docs/plans/one-binary-host-plan.md,
 * stage 1). Create one `AgentService` per process with `createAgentService`;
 * transports (HTTP routes today) hold it and call the functions below with it.
 */

// The service: its config (parsed once) and the one instance
export { loadConfig, type AgentConfig } from './lib/config';
export { createAgentService, type AgentService } from './lib/service';
export { ServiceError, type ServiceErrorCode } from './lib/errors';
export { harnessVersion } from './lib/platform/harness-version';
export { createJsonlTraceSink } from './lib/platform/trace-sink';

// Runs
export { startThreadRun } from './lib/runs/start-run';
export { isQueueStarting, queueMessage, sendQueuedNow, takeQueued } from './lib/runs/queue';
export { estimateContext } from './lib/runs/estimate-context';
export { readSettledLastRun } from './lib/runs/run-context';
export { initSystem1, system1AutoFor } from './lib/runs/system1-runtime';

// Threads: workspace access and file checkpoints
export { rememberWorkspace, WORKSPACE_NOT_PICKED } from './lib/threads/workspace-allowlist';
export { resolveWorkspaceDir, threadRunIds, workspaceAllowed } from './lib/threads/workspace';
export { forgetCheckpoints, revertRuns, runChanges, runFileDiff } from './lib/threads/checkpoints';

// Models and capacity
export { BalanceError, capacityEnabled, getOllamaBalance } from './lib/models/capacity';
export { resolveContextBudget, warnRoleModelsWithoutTools } from './lib/models/model-runtime';
export {
  parseModelSettingsBody,
  readModelSettings,
  resolveModelSettings,
  writeModelSettings,
} from './lib/models/model-settings-store';

// Skills
export { SkillError, createUserSkill, deleteUserSkill, readSkillDocument } from './lib/skills/user-skills';

// Voice
export { buildPrompt, gatedText, type VerboseTranscription } from './lib/voice/transcript-gate';
