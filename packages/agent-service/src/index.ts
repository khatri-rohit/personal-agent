/**
 * agent-service: the host's state and run logic, moved out of apps/api
 * unchanged (docs/plans/one-binary-host-plan.md, stage 1a). Transports
 * (HTTP routes today) import only from here.
 */

// Platform: home, shared instances, version
export { getAgentHome, getMemoryStore, getThreadStore, runManager } from './lib/platform/instances';
export { harnessVersion } from './lib/platform/harness-version';

// Runs
export { startThreadRun } from './lib/runs/start-run';
export { endpointFromLocal, prepareRun, readSettledLastRun, resolveRequestedSkills } from './lib/runs/run-context';
export { initSystem1, system1AutoFor } from './lib/runs/system1-runtime';

// Threads: workspace access and file checkpoints
export { isAllowedWorkspace, rememberWorkspace, WORKSPACE_NOT_PICKED } from './lib/threads/workspace-allowlist';
export { folderWriter, forgetCheckpoints, revertRuns, runChanges, runFileDiff } from './lib/threads/checkpoints';

// Memory
export { cancelLearningReview } from './lib/memory/learning-loop';

// Models and capacity
export { BalanceError, capacityEnabled, getOllamaBalance } from './lib/models/capacity';
export { warnRoleModelsWithoutTools } from './lib/models/model-runtime';
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
