/**
 * Command risk policy.
 *
 * Risk is a ladder, not a boolean: `autoApproveMaxRisk` decides up to which
 * level the agent may run commands unattended. Independent of that policy some
 * command classes ALWAYS require explicit confirmation — not because the agent
 * is untrusted, but because a misread task or wrong cwd can be catastrophic.
 */

export type CommandRiskLevel = "low" | "medium" | "high" | "critical";
export type AutoApproveMaxRisk = "none" | CommandRiskLevel;

export const RISK_ORDER: Record<AutoApproveMaxRisk, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function isAutoApproveMaxRisk(value: unknown): value is AutoApproveMaxRisk {
  return typeof value === "string" && value in RISK_ORDER;
}

export function normalizeRiskLevel(value: unknown): CommandRiskLevel {
  const level = String(value ?? "").trim().toLowerCase();
  if (level === "low" || level === "medium" || level === "high" || level === "critical") {
    return level;
  }
  if (level === "maximum" || level === "max" || level === "extreme") {
    return "critical";
  }
  // Unknown risk is treated conservatively.
  return "high";
}

export function riskRank(value: unknown): number {
  return RISK_ORDER[normalizeRiskLevel(value)];
}

export interface DangerousCommandDetection {
  dangerous: boolean;
  reason: string;
}

const DANGEROUS_RULES: Array<{ reason: string; pattern: RegExp }> = [
  { reason: "форматирование диска", pattern: /\bformat(?:\.com)?\s+[a-z]:/i },
  { reason: "разметка диска", pattern: /\bdiskpart\b/i },
  {
    reason: "рекурсивное удаление системного пути",
    pattern: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|\/\*|~|~\/\*|\*)/i,
  },
  {
    reason: "рекурсивное удаление пути в Windows",
    pattern: /\b(remove-item|ri|del|erase|rmdir)\b[^\n|;&]*-recurse\b/i,
  },
  {
    reason: "рекурсивное удаление каталога",
    pattern: /\brmdir\s+\/s\b/i,
  },
  { reason: "выключение/перезагрузка системы", pattern: /\b(shutdown|reboot|halt|poweroff)\b/i },
  { reason: "перезагрузка компьютера", pattern: /\b(restart-computer|stop-computer)\b/i },
  { reason: "смена runlevel", pattern: /\binit\s+[06]\b/i },
  { reason: "разрушение файловой системы", pattern: /\bmkfs(\.\w+)?\b/i },
  { reason: "запись на устройство напрямую", pattern: /\bdd\s+if=.*\bof=\/dev\//i },
  { reason: "изменение реестра", pattern: /\breg(\.exe)?\s+delete\b/i },
  { reason: "изменение реестра", pattern: /\b(remove-item|new-item|set-itemproperty)\s+hklm:/i },
  { reason: "удаление пользователя", pattern: /\bnet\s+user\s+\S+\s+\/delete\b/i },
  { reason: "удаление пользователя", pattern: /\b(remove-localuser|deluser|userdel)\b/i },
  { reason: "смена пароля/учётных данных", pattern: /\b(passwd|chpasswd|net\s+user\s+\S+\s+\*)\b/i },
  { reason: "отключение firewall", pattern: /\bnetsh\s+advfirewall\b[^\n]*\boff\b/i },
  { reason: "отключение firewall", pattern: /\bset-netfirewallprofile\b[^\n]*-enabled\b\s+false/i },
  { reason: "отключение firewall", pattern: /\bufw\s+disable\b/i },
  { reason: "сброс правил firewall", pattern: /\biptables\s+-f\b/i },
  { reason: "изменение прав на корень", pattern: /\bch(mod|own)\s+-r\b[^\n]*\s\/(\s|$)/i },
  { reason: "fork bomb", pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/ },
  { reason: "перезапись устройства", pattern: />\s*\/dev\/(sd|nvme|hd)/i },
];

export function detectDangerousCommand(command: string): DangerousCommandDetection {
  const value = command ?? "";
  if (!value.trim()) {
    return { dangerous: false, reason: "" };
  }
  for (const rule of DANGEROUS_RULES) {
    if (rule.pattern.test(value)) {
      return { dangerous: true, reason: rule.reason };
    }
  }
  return { dangerous: false, reason: "" };
}

/**
 * Whether a command must be confirmed even when auto-approval is enabled.
 * Dangerous command classes are never delegated to the model's risk label.
 */
export function requiresExplicitConfirmation(command: string): boolean {
  return detectDangerousCommand(command).dangerous;
}

/**
 * Decide whether the agent may auto-approve a command given the configured
 * maximum risk and the model-provided risk label.
 */
export function canAutoApprove(
  command: string,
  modelRiskLevel: unknown,
  maxRisk: AutoApproveMaxRisk,
): boolean {
  if (maxRisk === "none") {
    return false;
  }
  if (requiresExplicitConfirmation(command)) {
    return false;
  }
  return riskRank(modelRiskLevel) <= RISK_ORDER[maxRisk];
}
