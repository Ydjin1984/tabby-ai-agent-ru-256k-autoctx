/**
 * Environment detection and matching.
 *
 * Memory is only useful when it is bound to the environment it was learned in:
 * a `pnpm.cmd` fix that works on Windows/PowerShell is worthless on Ubuntu/zsh.
 * These helpers build a compact environment snapshot and score how closely two
 * snapshots relate.
 */

import { EnvironmentSnapshot } from "./types";
import { commandTool, unique } from "./text";

export function emptyEnvironment(): EnvironmentSnapshot {
  return {
    os: "",
    osVersion: "",
    shell: "",
    cwd: "",
    cwdType: "",
    runtime: "",
    tools: [],
  };
}

export function normalizeOs(platform: string | undefined | null): string {
  const value = (platform ?? "").toLowerCase();
  if (!value) {
    return "";
  }
  if (value.includes("win")) {
    return "windows";
  }
  if (value.includes("darwin") || value.includes("mac")) {
    return "macos";
  }
  if (value.includes("linux")) {
    return "linux";
  }
  return value;
}

export function createEnvironment(partial?: Partial<EnvironmentSnapshot>): EnvironmentSnapshot {
  const base = emptyEnvironment();
  if (!partial) {
    return base;
  }
  return {
    os: partial.os ?? base.os,
    osVersion: partial.osVersion ?? base.osVersion,
    shell: partial.shell ?? base.shell,
    cwd: partial.cwd ?? base.cwd,
    cwdType: partial.cwdType ?? base.cwdType,
    runtime: partial.runtime ?? base.runtime,
    tools: partial.tools ? unique(partial.tools.filter(Boolean)) : base.tools,
  };
}

export function detectOsName(): string {
  if (typeof process === "undefined") {
    return "";
  }
  return normalizeOs(process.platform);
}

export function detectShellFromProcess(): string {
  if (typeof process === "undefined" || !process.env) {
    return "";
  }
  const env = process.env;
  const comspec = env.ComSpec || env.COMSPEC || "";
  if (/pwsh/i.test(comspec)) {
    return "powershell";
  }
  if (/powershell/i.test(comspec)) {
    return "powershell";
  }
  if (/cmd\.exe/i.test(comspec)) {
    return "cmd";
  }
  const shell = env.SHELL || "";
  if (/zsh/.test(shell)) {
    return "zsh";
  }
  if (/bash/.test(shell)) {
    return "bash";
  }
  if (/fish/.test(shell)) {
    return "fish";
  }
  return "";
}

/** Best-effort shell detection from a Tabby terminal profile. */
export function detectShellFromProfile(profile: any): string {
  if (!profile) {
    return "";
  }
  const options = profile.options ?? {};
  const candidate = String(
    options.shell || options.command || profile.shell || profile.command || "",
  );
  if (!candidate) {
    return "";
  }
  const value = candidate.toLowerCase();
  if (value.includes("pwsh")) {
    return "powershell";
  }
  if (value.includes("powershell")) {
    return "powershell";
  }
  if (value.includes("cmd.exe") || value.endsWith("cmd")) {
    return "cmd";
  }
  if (value.includes("zsh")) {
    return "zsh";
  }
  if (value.includes("bash")) {
    return "bash";
  }
  if (value.includes("fish")) {
    return "fish";
  }
  return candidate.split(/[\\/]/).pop() ?? "";
}

/** Detect a shell from terminal output (prompt shapes). */
export function detectShellFromText(text: string): string {
  const value = text ?? "";
  if (/PS [^>\r\n]*>\s*$/im.test(value)) {
    return "powershell";
  }
  if (/^[A-Za-z]:\\[^>]*>\s*$/im.test(value)) {
    return "cmd";
  }
  if (/[^\s]+@[^\s]+:[^\s$#]*[#$]\s*$/m.test(value)) {
    return "bash";
  }
  return "";
}

export function mergeEnvironment(
  base: EnvironmentSnapshot,
  patch: Partial<EnvironmentSnapshot>,
): EnvironmentSnapshot {
  return createEnvironment({
    os: patch.os || base.os,
    osVersion: patch.osVersion || base.osVersion,
    shell: patch.shell || base.shell,
    cwd: patch.cwd || base.cwd,
    cwdType: patch.cwdType || base.cwdType,
    runtime: patch.runtime || base.runtime,
    tools: unique([...(base.tools ?? []), ...(patch.tools ?? [])]),
  });
}

const TOOL_TO_RUNTIME: Record<string, string> = {
  node: "node",
  npm: "node",
  npx: "node",
  pnpm: "node",
  yarn: "node",
  bun: "bun",
  deno: "deno",
  python: "python",
  python3: "python",
  py: "python",
  pip: "python",
  pip3: "python",
  poetry: "python",
  uv: "python",
  go: "go",
  cargo: "rust",
  rustc: "rust",
  dotnet: "dotnet",
  java: "java",
  mvn: "java",
  gradle: "java",
  ruby: "ruby",
  gem: "ruby",
  php: "php",
  composer: "php",
};

const TOOL_TO_CWD_TYPE: Record<string, string> = {
  node: "node_project",
  npm: "node_project",
  npx: "node_project",
  pnpm: "node_project",
  yarn: "node_project",
  bun: "node_project",
  python: "python_project",
  python3: "python_project",
  py: "python_project",
  pip: "python_project",
  pip3: "python_project",
  poetry: "python_project",
  uv: "python_project",
  git: "git_repo",
};

/** Fold a command into the environment so runtime/tools converge over time. */
export function inferEnvironmentFromCommand(
  command: string,
  base: EnvironmentSnapshot,
): EnvironmentSnapshot {
  const tool = commandTool(command);
  if (!tool) {
    return base;
  }
  const patch: Partial<EnvironmentSnapshot> = {
    tools: [tool],
  };
  const runtime = TOOL_TO_RUNTIME[tool];
  if (runtime && !base.runtime) {
    patch.runtime = runtime;
  }
  const cwdType = TOOL_TO_CWD_TYPE[tool];
  if (cwdType && !base.cwdType) {
    patch.cwdType = cwdType;
  }
  return mergeEnvironment(base, patch);
}

function fieldMatch(a: string, b: string): number | null {
  if (!a || !b) {
    return null;
  }
  if (a === b) {
    return 1;
  }
  if (a.startsWith(b) || b.startsWith(a)) {
    return 0.8;
  }
  return 0;
}

function toolsOverlap(a: string[], b: string[]): number | null {
  const left = new Set((a ?? []).filter(Boolean));
  const right = new Set((b ?? []).filter(Boolean));
  if (left.size === 0 || right.size === 0) {
    return null;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection++;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? null : intersection / union;
}

/**
 * Weighted similarity of two environment snapshots in [0, 1]. Fields that are
 * empty on both sides are ignored instead of dragging the score down, so an
 * unknown cwd does not invalidate an otherwise perfect match.
 */
export function environmentMatch(
  a: EnvironmentSnapshot,
  b: EnvironmentSnapshot,
): number {
  const parts: Array<[number, number | null]> = [
    [0.3, fieldMatch(a?.os ?? "", b?.os ?? "")],
    [0.25, fieldMatch(a?.shell ?? "", b?.shell ?? "")],
    [0.15, fieldMatch(a?.runtime ?? "", b?.runtime ?? "")],
    [0.1, fieldMatch(a?.cwdType ?? "", b?.cwdType ?? "")],
    [0.2, toolsOverlap(a?.tools ?? [], b?.tools ?? [])],
  ];
  let weighted = 0;
  let total = 0;
  for (const [weight, match] of parts) {
    if (match === null) {
      continue;
    }
    weighted += weight * match;
    total += weight;
  }
  return total > 0 ? weighted / total : 0.5;
}

/** Stable key used to group memories that were learned in the same environment. */
export function environmentKey(env: EnvironmentSnapshot): string {
  return [env?.os ?? "", env?.shell ?? "", env?.runtime ?? "", env?.cwdType ?? ""]
    .join("|")
    .toLowerCase();
}

export function describeEnvironment(env: EnvironmentSnapshot): string {
  const parts: string[] = [];
  if (env.os) {
    parts.push(env.osVersion ? `${env.os} ${env.osVersion}` : env.os);
  }
  if (env.shell) {
    parts.push(env.shell);
  }
  if (env.cwd) {
    parts.push(`cwd: ${env.cwd}`);
  } else if (env.cwdType) {
    parts.push(env.cwdType);
  }
  if (env.runtime) {
    parts.push(`runtime: ${env.runtime}`);
  }
  if (env.tools?.length) {
    parts.push(`tools: ${env.tools.slice(0, 8).join(", ")}`);
  }
  return parts.join(" · ");
}

export function environmentConstraints(env: EnvironmentSnapshot): string[] {
  const constraints: string[] = [];
  if (env.os) {
    constraints.push(`os=${env.os}`);
  }
  if (env.shell) {
    constraints.push(`shell=${env.shell}`);
  }
  if (env.runtime) {
    constraints.push(`runtime=${env.runtime}`);
  }
  return constraints;
}

export function environmentExclusions(env: EnvironmentSnapshot): string[] {
  if (env.os === "windows" && env.shell === "powershell") {
    return ["cmd.exe", "bash", "Linux"];
  }
  if (env.shell === "bash" || env.shell === "zsh") {
    return ["PowerShell", "cmd.exe"];
  }
  if (env.os === "windows") {
    return ["bash", "Linux"];
  }
  return [];
}
