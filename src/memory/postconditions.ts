/**
 * Postconditions — verify that a command actually achieved its goal instead of
 * trusting `exit_code == 0`.
 *
 * A postcondition is a lightweight, command-specific check over the terminal
 * output (and, where possible, the filesystem afterwards). When a rule matches
 * and reports success, it feeds the `expectedOutputMatched` signal in the
 * success score; when no rule is known the outcome stays unopinionated.
 */

export interface PostconditionResult {
  /** true/false when a rule matched, null when no rule applies. */
  matched: boolean | null;
  /** Human readable description of what was verified. */
  description: string;
}

interface PostconditionRule {
  id: string;
  test: RegExp;
  success: RegExp;
  failure?: RegExp;
  description: string;
}

const RULES: PostconditionRule[] = [
  {
    id: "python_package_install",
    test: /\b(pip|pip3|py -m pip|python -m pip)\b.*\binstall\b/i,
    success: /Successfully installed|Requirement already satisfied|already satisfied|Installing collected packages/i,
    failure: /ERROR:|No matching distribution|Could not find a version/i,
    description: "пакет Python установлен (pip сообщил об успехе)",
  },
  {
    id: "node_package_install",
    test: /\b(npm|pnpm|yarn|bun)\b.*\b(install|i|ci|add)\b/i,
    success: /added \d+ package|up to date|already up[- ]to[- ]date|Done in|Lockfile is up to date|packages in \d/i,
    failure: /npm ERR!|ERR_PNPM|error An unexpected error occurred/i,
    description: "зависимости Node установлены (менеджер сообщил об успехе)",
  },
  {
    id: "git_clone",
    test: /\bgit\s+clone\b/i,
    success: /Cloning into|Receiving objects|Resolving deltas|done\./i,
    failure: /fatal:|Could not resolve host/i,
    description: "репозиторий склонирован",
  },
  {
    id: "git_commit",
    test: /\bgit\s+commit\b/i,
    success: /\[\S+ [0-9a-f]{6,}\]|files? changed|create mode|insertion|deletion/i,
    failure: /nothing to commit|fatal:/i,
    description: "коммит создан",
  },
  {
    id: "docker_build",
    test: /\bdocker\s+build\b/i,
    success: /Successfully built|writing image|naming to|exporting to image/i,
    failure: /ERROR|failed to solve/i,
    description: "Docker-образ собран",
  },
  {
    id: "compiled_build",
    test: /\b(cargo|go|dotnet|mvn|gradle|make|cmake)\b.*\b(build|test|install|compile)\b/i,
    success: /Finished|BUILD SUCCESS|Compiling|Building|built|test result: ok|Build succeeded|\[100%\]/i,
    failure: /error\[|BUILD FAILED|error:|compilation failed/i,
    description: "сборка/тесты завершились успешно",
  },
  {
    id: "file_transfer",
    test: /\b(curl|wget)\b/i,
    success: /200 OK|100%\s|saved|written to/i,
    failure: /404 Not Found|Could not resolve host|Connection refused/i,
    description: "файл получен",
  },
];

export function evaluatePostcondition(
  command: string,
  output: string,
): PostconditionResult {
  const cmd = command ?? "";
  const text = output ?? "";
  for (const rule of RULES) {
    if (!rule.test.test(cmd)) {
      continue;
    }
    if (rule.success.test(text)) {
      return { matched: true, description: rule.description };
    }
    if (rule.failure && rule.failure.test(text)) {
      return { matched: false, description: rule.description };
    }
    // Rule applies but the output is inconclusive.
    return { matched: null, description: rule.description };
  }
  return { matched: null, description: "" };
}
