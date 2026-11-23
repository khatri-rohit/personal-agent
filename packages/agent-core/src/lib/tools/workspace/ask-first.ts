import path from 'node:path';

/**
 * Ask before what a checkpoint cannot undo (B2, part 2). Inside the folder,
 * a checkpoint puts files back; these reach past it: commands that send
 * something off the machine, and paths outside the folder. A short list,
 * not a classifier: an indirect command (a script that does the same) can
 * still slip past, which is accepted while a person watches the run.
 *
 * curl, wget, Invoke-WebRequest and Invoke-RestMethod are refused outright
 * by the deny list (tools.ts), not asked about.
 */

const OFF_MACHINE: { pattern: RegExp; what: string }[] = [
  { pattern: /^git\b.*\bpush\b/i, what: 'pushes to a remote repository' },
  { pattern: /^git\b.*\bsend-email\b/i, what: 'sends email' },
  {
    pattern: /^(npm|pnpm|yarn|bun|npx|cargo|dotnet|nuget|poetry|twine|gem|vsce|ovsx|flit|hatch|uv)\b.*\b(publish|upload|push)\b/i,
    what: 'publishes a package',
  },
  { pattern: /^docker\b.*\bpush\b/i, what: 'pushes an image to a registry' },
  { pattern: /^(ssh|scp|sftp|rsync|ftp)\b/i, what: 'connects to another machine' },
  { pattern: /^gh\b/i, what: 'acts on GitHub with your account' },
  { pattern: /^(iwr|irm)\b/i, what: 'sends a web request' },
];

/** Split on && || ; | & and newlines, outside quotes, so each command is checked on its own. */
function segments(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter(Boolean);
}

/** Words of one command, quotes removed (good enough to spot path arguments). */
function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, ''));
}

/** Variables that name folders outside the workspace (`%PATH%` and the like are not paths). */
const HOME_LIKE =
  /^(~([\\/]|$)|%(USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|PROGRAMDATA|PROGRAMFILES[^%]*|WINDIR|SYSTEMROOT|PUBLIC|ONEDRIVE)%|\$\{?(HOME|TMPDIR)\b|\$env:(USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|HOME))/i;

/** A word that names a place outside `root`, or null. Windows switches (`/s`) and `HEAD..main` are not paths. */
function outsidePath(word: string, root: string, platform: NodeJS.Platform): string | null {
  // `--out=../x`: the path is after the `=`; `>../x`, `2>>C:\log`: after the redirect.
  const value = (word.includes('=') ? word.slice(word.lastIndexOf('=') + 1) : word).replace(/^\d*[<>]+/, '');
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null; // URL
  if (HOME_LIKE.test(value)) return value;
  const absolute =
    platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') : value.startsWith('/');
  const escapes = /(^|[\\/])\.\.([\\/]|$)/.test(value);
  if (!absolute && !escapes) return null;
  const resolved = platform === 'win32' ? path.win32.resolve(root, value) : path.posix.resolve(root, value);
  const base = platform === 'win32' ? path.win32.resolve(root) : path.posix.resolve(root);
  const inside =
    platform === 'win32'
      ? resolved.toLowerCase() === base.toLowerCase() || resolved.toLowerCase().startsWith(`${base.toLowerCase()}\\`)
      : resolved === base || resolved.startsWith(`${base}/`);
  return inside ? null : value;
}

/** Why this command needs the user's yes, or null when it runs as usual. */
export function askFirstReason(command: string, root: string, platform: NodeJS.Platform = process.platform): string | null {
  for (const segment of segments(command)) {
    for (const rule of OFF_MACHINE) {
      if (rule.pattern.test(segment)) return `it ${rule.what}, which a checkpoint cannot undo`;
    }
    for (const word of words(segment).slice(1)) {
      const outside = outsidePath(word, root, platform);
      if (outside) return `it names a path outside the workspace folder (${outside}), where a checkpoint cannot undo changes`;
    }
  }
  return null;
}
