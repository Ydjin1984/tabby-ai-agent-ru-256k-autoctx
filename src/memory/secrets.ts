/**
 * Secret redaction.
 *
 * Applied BEFORE anything reaches the store, so API keys, bearer tokens,
 * cookies, passwords and connection strings never end up on disk in
 * `~/.tabby-ai-agent/memory.json`. Redaction at write time (not at retrieval)
 * is the only safe order: unredacted data would otherwise be persisted.
 */

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // OpenAI / generic sk- keys
  { pattern: /sk-[A-Za-z0-9_-]{16,}/g, replacement: "sk-***" },
  // Stripe-style keys (sk_live_… / rk_test_…)
  {
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    replacement: "sk_live_***",
  },
  // Telegram bot token (123456789:AAE…)
  {
    pattern: /\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/g,
    replacement: "***:***",
  },
  // GitHub personal/app/refresh tokens
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "ghp_***" },
  // GitLab personal access token
  { pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g, replacement: "glpat-***" },
  // Slack tokens
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "xox*-***",
  },
  // npm automation token
  { pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g, replacement: "npm_***" },
  // Google API key
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replacement: "AIza***" },
  // SendGrid
  { pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, replacement: "SG.***.***" },
  // Bearer tokens
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "$1***" },
  // Authorization headers (keep the scheme, drop the credential)
  {
    pattern: /(authorization["'\s:=]+)(bearer\s+)?[^\s"',;]+/gi,
    replacement: "$1$2***",
  },
  // key=value pairs for common secret names
  {
    pattern:
      /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret[_-]?access[_-]?key|aws[_-]?secret|client[_-]?secret|telegram[_-]?token|bot[_-]?token|secret|password|passwd|pwd|private[_-]?key|session[_-]?id)\s*[=:]\s*)("?)([^\s"',;]+)/gi,
    replacement: "$1$2***",
  },
  // AWS access key id
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "AKIA***" },
  // JWT
  {
    pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: "eyJ***.***.***",
  },
  // PEM private keys
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----",
  },
  // Credentials embedded in URLs (postgres://user:pass@host)
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s:@]+@/gi,
    replacement: "$1***:***@",
  },
  // Cookies
  { pattern: /(cookie["'\s:=]+)[^\r\n]+/gi, replacement: "$1***" },
  // .env style lines with a high-entropy value
  {
    pattern: /^([A-Z][A-Z0-9_]{2,})\s*=\s*["']?[^\s"']{12,}["']?$/gm,
    replacement: "$1=***",
  },
];

export function redactSecrets(text: string): string {
  if (!text) {
    return text;
  }
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function containsSecrets(text: string): boolean {
  if (!text) {
    return false;
  }
  for (const { pattern } of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes reused across calls.
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}
