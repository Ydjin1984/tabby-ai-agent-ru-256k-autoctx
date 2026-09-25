/**
 * Реестр тем боковой панели агента.
 *
 * Чтобы добавить новую тему — допишите объект `ThemeDefinition` в `THEME_DEFINITIONS`
 * ниже: панель сама применит палитру, а пункт появится в меню «Тема». Ничего больше
 * менять не нужно. `mode` задаёт структуру: "log" — терминальный журнал без карточек,
 * "cards" — карточки сообщений.
 */

export type PanelThemeMode = "log" | "cards";

export interface ThemeSyntax {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  type: string;
  tag: string;
  attr: string;
  punctuation: string;
}

export interface ThemeDefinition {
  id: string;
  label: string;
  description: string;
  mode: PanelThemeMode;
  /** Цвет-образец для меню и настроек. */
  swatch: string;
  /** Палитра. Базы задаются HEX — производные (soft/line) считаются автоматически. */
  bg0: string;
  bg1: string;
  bg2?: string;
  bg3?: string;
  fg: string;
  fgDim: string;
  line?: string;
  line2?: string;
  accent: string;
  user?: string;
  assistant?: string;
  reasoning?: string;
  tool?: string;
  success: string;
  warn: string;
  danger: string;
  info: string;
  cardBg?: string;
  cardBorder?: string;
  codeBg?: string;
  codeFg?: string;
  codeHeadBg?: string;
  radius?: string;
  btnRadius?: string;
  proseFont?: string;
  proseSize?: string;
  proseLh?: string;
  roleTransform?: string;
  roleTracking?: string;
  meter?: string;
  syntax?: Partial<ThemeSyntax>;
  langJson?: string;
  langPowerShell?: string;
  langHtml?: string;
}

export interface PanelTheme extends ThemeDefinition {
  /** CSS-переменные, которые панель вешает на свой host-элемент. */
  vars: Record<string, string>;
}

const DEFAULT_SYNTAX: ThemeSyntax = {
  keyword: "#c792ea",
  string: "#c3e88d",
  number: "#f78c6c",
  comment: "#7d8b9e",
  function: "#82aaff",
  type: "#ffcb6b",
  tag: "#f07178",
  attr: "#c3e88d",
  punctuation: "#89a0b5",
};

function hexToRgb(hex: string): [number, number, number] {
  let value = hex.trim().replace(/^#/, "");
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const parsed = Number.parseInt(value, 16);
  if (!Number.isFinite(parsed)) {
    return [255, 255, 255];
  }
  return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255];
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function rgbTriplet(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${r}, ${g}, ${b}`;
}

function buildVars(def: ThemeDefinition): Record<string, string> {
  const syntax: ThemeSyntax = { ...DEFAULT_SYNTAX, ...(def.syntax ?? {}) };
  const user = def.user ?? def.accent;
  const assistant = def.assistant ?? def.accent;
  const reasoning = def.reasoning ?? def.fgDim;
  const tool = def.tool ?? def.warn;
  const radius = def.radius ?? "10px";
  const bg2 = def.bg2 ?? def.bg0;
  const bg3 = def.bg3 ?? def.bg1;

  return {
    // Переопределяем переменные темы Tabby — так существующие правила перекрашиваются.
    "--theme-bg": def.bg0,
    "--theme-bg-more": def.bg1,
    "--theme-fg": def.fg,
    "--theme-fg-muted": def.fgDim,
    "--theme-border": def.line ?? def.line2 ?? rgba(def.fg, 0.16),
    "--theme-primary": def.accent,
    "--theme-primary-rgb": rgbTriplet(def.accent),
    // Bootstrap-переменные, которыми пользуется существующая разметка панели.
    "--bs-success": def.success,
    "--bs-warning": def.warn,
    "--bs-danger": def.danger,
    "--bs-info": def.info,

    // Расширенный набор панели.
    "--ap-bg0": def.bg0,
    "--ap-bg1": def.bg1,
    "--ap-bg2": bg2,
    "--ap-bg3": bg3,
    "--ap-line": def.line ?? rgba(def.fg, 0.08),
    "--ap-line2": def.line2 ?? rgba(def.fg, 0.18),
    "--ap-fg": def.fg,
    "--ap-fg-dim": def.fgDim,
    "--ap-accent": def.accent,
    "--ap-accent-ink": "#0a0f14",
    "--ap-accent-soft": rgba(def.accent, 0.14),
    "--ap-accent-line": rgba(def.accent, 0.5),

    "--ap-user": user,
    "--ap-user-fill": rgba(user, 0.1),
    "--ap-user-border": rgba(user, 0.28),
    "--ap-assistant": assistant,
    "--ap-reasoning": reasoning,
    "--ap-reasoning-fill": rgba(reasoning, 0.08),
    "--ap-reasoning-border": rgba(reasoning, 0.24),
    "--ap-tool": tool,

    "--ap-success": def.success,
    "--ap-success-soft": rgba(def.success, 0.14),
    "--ap-success-line": rgba(def.success, 0.45),
    "--ap-warn": def.warn,
    "--ap-warn-soft": rgba(def.warn, 0.16),
    "--ap-warn-line": rgba(def.warn, 0.48),
    "--ap-danger": def.danger,
    "--ap-danger-soft": rgba(def.danger, 0.14),
    "--ap-danger-line": rgba(def.danger, 0.45),
    "--ap-info": def.info,
    "--ap-info-soft": rgba(def.info, 0.07),
    "--ap-info-line": rgba(def.info, 0.42),
    "--ap-info-soft-2": rgba(def.info, 0.16),

    "--ap-card-bg": def.cardBg ?? def.bg1,
    "--ap-card-border": def.cardBorder ?? def.line ?? rgba(def.fg, 0.08),
    "--ap-radius": radius,
    "--ap-btn-radius": def.btnRadius ?? radius,
    "--ap-code-bg": def.codeBg ?? bg2,
    "--ap-code-fg": def.codeFg ?? def.fg,
    "--ap-code-head-bg": def.codeHeadBg ?? def.bg1,
    "--ap-inline-bg": rgba(def.accent, 0.12),
    "--ap-inline-fg": def.fg,
    "--ap-inline-border": rgba(def.accent, 0.22),
    "--ap-th-bg": bg3,
    "--ap-tr-alt": rgba(def.fg, 0.03),
    "--ap-meter": def.meter ?? def.accent,

    "--ap-prose-font": def.proseFont ?? "inherit",
    "--ap-prose-size": def.proseSize ?? "13.5px",
    "--ap-prose-lh": def.proseLh ?? "1.6",
    "--ap-role-transform": def.roleTransform ?? "none",
    "--ap-role-tracking": def.roleTracking ?? "0",

    "--ap-syn-keyword": syntax.keyword,
    "--ap-syn-string": syntax.string,
    "--ap-syn-number": syntax.number,
    "--ap-syn-comment": syntax.comment,
    "--ap-syn-function": syntax.function,
    "--ap-syn-type": syntax.type,
    "--ap-syn-tag": syntax.tag,
    "--ap-syn-attr": syntax.attr,
    "--ap-syn-punctuation": syntax.punctuation,

    "--ap-lang-json": def.langJson ?? def.warn,
    "--ap-lang-powershell": def.langPowerShell ?? def.info,
    "--ap-lang-html": def.langHtml ?? def.danger,
  };
}

const THEME_DEFINITIONS: ThemeDefinition[] = [
  {
    id: "ink",
    label: "Сигнальные чернила",
    description: "Linear/Raycast: плоские карточки, полоса роли, цвет только у статусов",
    mode: "cards",
    swatch: "#8aa4ff",
    bg0: "#0e1116",
    bg1: "#161b22",
    bg2: "#0a0d12",
    bg3: "#1c2430",
    fg: "#e8eef6",
    fgDim: "#93a0b4",
    line: "rgba(232, 238, 246, 0.08)",
    line2: "rgba(232, 238, 246, 0.18)",
    accent: "#8aa4ff",
    user: "#6e9bff",
    reasoning: "#8e7cc3",
    tool: "#e2b15a",
    success: "#5ee0a8",
    warn: "#f3d48a",
    danger: "#ff8e8e",
    info: "#9ccbff",
    langPowerShell: "#5b9dff",
    langHtml: "#f07178",
  },
  {
    id: "neon-log",
    label: "Форсфордный журнал",
    description: "Терминальный лог без карточек: роли-префиксы, неон, моно-проза",
    mode: "log",
    swatch: "#3ddc97",
    bg0: "#070908",
    bg1: "#0a0d0b",
    bg2: "#050605",
    bg3: "#0e1411",
    fg: "#d7e5dc",
    fgDim: "#7e9086",
    line: "rgba(61, 220, 151, 0.12)",
    line2: "rgba(61, 220, 151, 0.3)",
    accent: "#3ddc97",
    user: "#3ddc97",
    reasoning: "#8a9c90",
    tool: "#e2b15a",
    success: "#3ddc97",
    warn: "#e2b15a",
    danger: "#ff6b6b",
    info: "#6cb6ff",
    codeBg: "#050605",
    codeHeadBg: "#0a0d0b",
    radius: "4px",
    btnRadius: "3px",
    proseFont: 'var(--monospace-font, Consolas, monospace)',
    proseSize: "12.5px",
    proseLh: "1.65",
    roleTransform: "uppercase",
    roleTracking: "0.08em",
    meter: "#3ddc97",
    syntax: {
      keyword: "#3ddc97",
      string: "#c3e88d",
      number: "#f78c6c",
      comment: "#5a6b60",
      function: "#7ee787",
      type: "#e2b15a",
      tag: "#ff7b72",
      attr: "#79c0ff",
      punctuation: "#7e9086",
    },
    langJson: "#e2b15a",
    langPowerShell: "#3ddc97",
    langHtml: "#ff7b72",
  },
  {
    id: "midnight",
    label: "Полночь",
    description: "Глубокий тёмно-синий, белый текст, яркая семантика — максимальная читаемость",
    mode: "cards",
    swatch: "#4aa8ff",
    bg0: "#05070d",
    bg1: "#0c111c",
    bg2: "#03050a",
    bg3: "#131a28",
    fg: "#eef3ff",
    fgDim: "#93a2c4",
    line: "rgba(238, 243, 255, 0.10)",
    line2: "rgba(238, 243, 255, 0.24)",
    accent: "#4aa8ff",
    user: "#4aa8ff",
    reasoning: "#a78bfa",
    tool: "#ffb020",
    success: "#22e06a",
    warn: "#ffcc33",
    danger: "#ff4d5e",
    info: "#4aa8ff",
    codeBg: "#03050a",
    codeHeadBg: "#0c111c",
    radius: "12px",
    syntax: {
      keyword: "#a78bfa",
      string: "#7ee787",
      number: "#ffab70",
      comment: "#6b7ba0",
      function: "#4aa8ff",
      type: "#ffd479",
      tag: "#ff7b8a",
      attr: "#7ee787",
      punctuation: "#93a2c4",
    },
    langJson: "#ffd479",
    langPowerShell: "#4aa8ff",
    langHtml: "#ff7b8a",
  },
  {
    id: "contrast",
    label: "Контраст",
    description: "Чёрный фон и белый текст, максимальный контраст: зелёное — зелёное, красное — красное",
    mode: "cards",
    swatch: "#00e676",
    bg0: "#000000",
    bg1: "#0c0c0e",
    bg2: "#000000",
    bg3: "#17171b",
    fg: "#ffffff",
    fgDim: "#b8b8c0",
    line: "rgba(255, 255, 255, 0.16)",
    line2: "rgba(255, 255, 255, 0.34)",
    accent: "#00b3ff",
    user: "#00b3ff",
    reasoning: "#c77dff",
    tool: "#ffd000",
    success: "#00e676",
    warn: "#ffd600",
    danger: "#ff1744",
    info: "#40c4ff",
    codeBg: "#000000",
    codeHeadBg: "#0c0c0e",
    radius: "8px",
    syntax: {
      keyword: "#ff79c6",
      string: "#00e676",
      number: "#ff9100",
      comment: "#8b8b96",
      function: "#40c4ff",
      type: "#ffd600",
      tag: "#ff1744",
      attr: "#00e676",
      punctuation: "#b8b8c0",
    },
    langJson: "#ffd600",
    langPowerShell: "#40c4ff",
    langHtml: "#ff1744",
  },
  {
    id: "matrix",
    label: "Матрица",
    description: "Чёрный экран, зелёный неон и чёткие красный/жёлтый — терминал как в кино",
    mode: "log",
    swatch: "#00ff41",
    bg0: "#000600",
    bg1: "#04120a",
    bg2: "#000400",
    bg3: "#082015",
    fg: "#d7ffe4",
    fgDim: "#6fae89",
    line: "rgba(0, 255, 65, 0.14)",
    line2: "rgba(0, 255, 65, 0.36)",
    accent: "#00ff41",
    user: "#00ff41",
    reasoning: "#7fd4a0",
    tool: "#ffd000",
    success: "#00ff41",
    warn: "#ffd000",
    danger: "#ff3b3b",
    info: "#4fd1ff",
    codeBg: "#000400",
    codeHeadBg: "#04120a",
    radius: "3px",
    btnRadius: "3px",
    proseFont: 'var(--monospace-font, Consolas, monospace)',
    proseSize: "12.5px",
    proseLh: "1.65",
    roleTransform: "uppercase",
    roleTracking: "0.08em",
    syntax: {
      keyword: "#00ff41",
      string: "#9bff9b",
      number: "#ffd000",
      comment: "#3f7a55",
      function: "#5effa0",
      type: "#ffd000",
      tag: "#ff5c5c",
      attr: "#7fe0a0",
      punctuation: "#6fae89",
    },
    langJson: "#ffd000",
    langPowerShell: "#00ff41",
    langHtml: "#ff5c5c",
  },
  {
    id: "dracula",
    label: "Dracula",
    description: "Классическая тёмная схема: мягкий контраст, узнаваемые фиолетовый и зелёный",
    mode: "cards",
    swatch: "#bd93f9",
    bg0: "#1e1f29",
    bg1: "#282a36",
    bg2: "#161821",
    bg3: "#343746",
    fg: "#f8f8f2",
    fgDim: "#a9b0c9",
    line: "rgba(248, 248, 242, 0.10)",
    line2: "rgba(248, 248, 242, 0.24)",
    accent: "#bd93f9",
    user: "#8be9fd",
    reasoning: "#bd93f9",
    tool: "#ffb86c",
    success: "#50fa7b",
    warn: "#f1fa8c",
    danger: "#ff5555",
    info: "#8be9fd",
    codeBg: "#161821",
    codeHeadBg: "#282a36",
    radius: "12px",
    syntax: {
      keyword: "#ff79c6",
      string: "#f1fa8c",
      number: "#bd93f9",
      comment: "#6272a4",
      function: "#50fa7b",
      type: "#8be9fd",
      tag: "#ff5555",
      attr: "#50fa7b",
      punctuation: "#f8f8f2",
    },
    langJson: "#f1fa8c",
    langPowerShell: "#8be9fd",
    langHtml: "#ff5555",
  },
  {
    id: "one-dark",
    label: "One Dark",
    description: "Тёплая тёмная классика для кода: спокойный фон, яркие акценты",
    mode: "cards",
    swatch: "#61afef",
    bg0: "#1b1f27",
    bg1: "#282c34",
    bg2: "#14171d",
    bg3: "#333842",
    fg: "#e6e9ef",
    fgDim: "#98a1b3",
    line: "rgba(230, 233, 239, 0.10)",
    line2: "rgba(230, 233, 239, 0.24)",
    accent: "#61afef",
    user: "#61afef",
    reasoning: "#c678dd",
    tool: "#e5c07b",
    success: "#98c379",
    warn: "#e5c07b",
    danger: "#e06c75",
    info: "#56b6c2",
    codeBg: "#14171d",
    codeHeadBg: "#282c34",
    radius: "10px",
    syntax: {
      keyword: "#c678dd",
      string: "#98c379",
      number: "#d19a66",
      comment: "#7f848e",
      function: "#61afef",
      type: "#e5c07b",
      tag: "#e06c75",
      attr: "#98c379",
      punctuation: "#abb2bf",
    },
    langJson: "#e5c07b",
    langPowerShell: "#61afef",
    langHtml: "#e06c75",
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    description: "Ретро-тёмная с высоким контрастом: тёплые жёлтый и зелёный, красный для ошибок",
    mode: "cards",
    swatch: "#fabd2f",
    bg0: "#1d2021",
    bg1: "#282828",
    bg2: "#141617",
    bg3: "#32302f",
    fg: "#fbf1c7",
    fgDim: "#bdae93",
    line: "rgba(251, 241, 199, 0.12)",
    line2: "rgba(251, 241, 199, 0.26)",
    accent: "#fabd2f",
    user: "#83a598",
    reasoning: "#d3869b",
    tool: "#fe8019",
    success: "#b8bb26",
    warn: "#fabd2f",
    danger: "#fb4934",
    info: "#83a598",
    codeBg: "#141617",
    codeHeadBg: "#282828",
    radius: "6px",
    syntax: {
      keyword: "#fb4934",
      string: "#b8bb26",
      number: "#d3869b",
      comment: "#928374",
      function: "#fabd2f",
      type: "#83a598",
      tag: "#fb4934",
      attr: "#b8bb26",
      punctuation: "#bdae93",
    },
    langJson: "#fabd2f",
    langPowerShell: "#83a598",
    langHtml: "#fb4934",
  },
  {
    id: "notebook",
    label: "Янтарная тетрадь",
    description: "Тёплая заметка: серифная проза ответа, янтарный акцент",
    mode: "cards",
    swatch: "#e2a04a",
    bg0: "#14110e",
    bg1: "#1c1814",
    bg2: "#100e0c",
    bg3: "#241e17",
    fg: "#efe6d8",
    fgDim: "#a99a82",
    line: "rgba(226, 160, 74, 0.16)",
    line2: "rgba(226, 160, 74, 0.32)",
    accent: "#e2a04a",
    user: "#c98a3c",
    reasoning: "#b08968",
    tool: "#e2a04a",
    success: "#9bbf6a",
    warn: "#e2a04a",
    danger: "#d96c5f",
    info: "#7fa8c9",
    radius: "6px",
    proseFont: 'Georgia, "Times New Roman", serif',
    proseSize: "14.5px",
    proseLh: "1.7",
    syntax: {
      keyword: "#e2a04a",
      string: "#b8c77a",
      number: "#e08a5b",
      comment: "#8a7a63",
      function: "#d9b36c",
      type: "#c9a227",
      tag: "#d96c5f",
      attr: "#b8c77a",
      punctuation: "#a99a82",
    },
    langJson: "#e2a04a",
    langPowerShell: "#7fa8c9",
    langHtml: "#d96c5f",
  },
  {
    id: "frost",
    label: "Иней",
    description: "Nord-холод: мягкие карточки, крупные радиусы, приглушённая подсветка",
    mode: "cards",
    swatch: "#88c0d0",
    bg0: "#0f1419",
    bg1: "#141b22",
    bg2: "#0b0f13",
    bg3: "#1b242e",
    fg: "#e5e9f0",
    fgDim: "#94a3b8",
    line: "rgba(136, 192, 208, 0.16)",
    line2: "rgba(136, 192, 208, 0.34)",
    accent: "#88c0d0",
    user: "#88c0d0",
    reasoning: "#b48ead",
    tool: "#ebcb8b",
    success: "#a3be8c",
    warn: "#ebcb8b",
    danger: "#bf616a",
    info: "#81a1c1",
    cardBg: "rgba(136, 192, 208, 0.05)",
    radius: "14px",
    btnRadius: "9px",
    syntax: {
      keyword: "#b48ead",
      string: "#a3be8c",
      number: "#d08770",
      comment: "#6b7a8f",
      function: "#88c0d0",
      type: "#ebcb8b",
      tag: "#bf616a",
      attr: "#8fbcbb",
      punctuation: "#94a3b8",
    },
    langJson: "#ebcb8b",
    langPowerShell: "#88c0d0",
    langHtml: "#bf616a",
  },
  {
    id: "console",
    label: "Пульт",
    description: "Mission control: нулевые радиусы, сетка, cyan для данных, amber для ожидания",
    mode: "cards",
    swatch: "#39d6e0",
    bg0: "#0b0e11",
    bg1: "#10151a",
    bg2: "#080a0d",
    bg3: "#161c22",
    fg: "#dce6ee",
    fgDim: "#8296a5",
    line: "#24303a",
    line2: "#33424e",
    accent: "#39d6e0",
    user: "#39d6e0",
    reasoning: "#7c8b99",
    tool: "#e2b15a",
    success: "#3ddc97",
    warn: "#e2b15a",
    danger: "#ff6b6b",
    info: "#6cb6ff",
    radius: "0px",
    btnRadius: "0px",
    roleTransform: "uppercase",
    roleTracking: "0.09em",
    syntax: {
      keyword: "#39d6e0",
      string: "#9be38a",
      number: "#f2a65a",
      comment: "#5d707e",
      function: "#6fb8ff",
      type: "#e2b15a",
      tag: "#ff6b6b",
      attr: "#9be38a",
      punctuation: "#8296a5",
    },
    langJson: "#e2b15a",
    langPowerShell: "#39d6e0",
    langHtml: "#ff6b6b",
  },
  {
    id: "aurora",
    label: "Glass Aurora",
    description: "Премиум-стекло: градиент violet→cyan, глянцевые шапки кода",
    mode: "cards",
    swatch: "#a78bfa",
    bg0: "#0b0f17",
    bg1: "#121826",
    bg2: "#080b12",
    bg3: "#182031",
    fg: "#e7ecf5",
    fgDim: "#96a3b8",
    line: "rgba(148, 163, 184, 0.14)",
    line2: "rgba(148, 163, 184, 0.3)",
    accent: "#a78bfa",
    user: "#a78bfa",
    reasoning: "#c084fc",
    tool: "#fbbf24",
    success: "#34d399",
    warn: "#fbbf24",
    danger: "#fb7185",
    info: "#38bdf8",
    cardBg: "rgba(255, 255, 255, 0.028)",
    radius: "16px",
    btnRadius: "10px",
    meter: "linear-gradient(90deg, #a78bfa, #22d3ee)",
    syntax: {
      keyword: "#c4a7ff",
      string: "#9de5b0",
      number: "#f6a96b",
      comment: "#6b7a99",
      function: "#7dd3fc",
      type: "#fcd34d",
      tag: "#fb7185",
      attr: "#9de5b0",
      punctuation: "#94a3b8",
    },
    langJson: "#fcd34d",
    langPowerShell: "#7dd3fc",
    langHtml: "#fb7185",
  },
  {
    id: "tabby",
    label: "Как в Tabby",
    description: "Панель следует цветам темы терминала",
    mode: "cards",
    swatch: "#6c9df0",
    bg0: "var(--theme-bg)",
    bg1: "var(--theme-bg-more)",
    fg: "var(--theme-fg)",
    fgDim: "var(--theme-fg-muted)",
    accent: "var(--theme-primary)",
    success: "#3ddc97",
    warn: "#e2b15a",
    danger: "#ff6b6b",
    info: "#6cb6ff",
  },
];

/**
 * Тема «Как в Tabby» не задаёт свою палитру, а переадресует переменные панели на
 * переменные темы терминала — смена темы Tabby сразу отражается на панели.
 */
function tabbyVars(): Record<string, string> {
  return {
    "--ap-bg0": "var(--theme-bg)",
    "--ap-bg1": "var(--theme-bg-more)",
    "--ap-bg2": "var(--theme-bg)",
    "--ap-bg3": "var(--theme-bg-more)",
    "--ap-line": "var(--theme-border)",
    "--ap-line2": "var(--theme-border)",
    "--ap-fg": "var(--theme-fg)",
    "--ap-fg-dim": "var(--theme-fg-muted)",
    "--ap-accent": "var(--theme-primary)",
    "--ap-accent-soft": "rgba(var(--theme-primary-rgb), 0.14)",
    "--ap-accent-line": "rgba(var(--theme-primary-rgb), 0.5)",
    "--ap-user": "var(--theme-primary)",
    "--ap-user-fill": "rgba(var(--theme-primary-rgb), 0.1)",
    "--ap-user-border": "rgba(var(--theme-primary-rgb), 0.28)",
    "--ap-assistant": "var(--theme-primary)",
    "--ap-reasoning": "var(--theme-fg-muted)",
    "--ap-reasoning-fill": "rgba(var(--theme-primary-rgb), 0.06)",
    "--ap-reasoning-border": "rgba(var(--theme-primary-rgb), 0.35)",
    "--ap-tool": "var(--bs-warning)",
    "--ap-success": "var(--bs-success)",
    "--ap-success-soft": "rgba(25, 135, 84, 0.12)",
    "--ap-success-line": "rgba(25, 135, 84, 0.4)",
    "--ap-warn": "var(--bs-warning)",
    "--ap-warn-soft": "rgba(255, 193, 7, 0.12)",
    "--ap-warn-line": "rgba(255, 193, 7, 0.4)",
    "--ap-danger": "var(--bs-danger)",
    "--ap-danger-soft": "rgba(220, 53, 69, 0.12)",
    "--ap-danger-line": "rgba(220, 53, 69, 0.4)",
    "--ap-info": "#6cb6ff",
    "--ap-info-soft": "rgba(108, 182, 255, 0.07)",
    "--ap-info-soft-2": "rgba(108, 182, 255, 0.16)",
    "--ap-info-line": "rgba(108, 182, 255, 0.42)",
    "--ap-card-bg": "var(--theme-bg-more)",
    "--ap-card-border": "var(--theme-border)",
    "--ap-radius": "10px",
    "--ap-btn-radius": "7px",
    "--ap-code-bg": "var(--theme-bg)",
    "--ap-code-fg": "var(--theme-fg)",
    "--ap-code-head-bg": "var(--theme-bg-more)",
    "--ap-inline-bg": "rgba(var(--theme-primary-rgb), 0.12)",
    "--ap-inline-fg": "var(--theme-fg)",
    "--ap-inline-border": "rgba(var(--theme-primary-rgb), 0.22)",
    "--ap-th-bg": "var(--theme-bg-more)",
    "--ap-tr-alt": "rgba(var(--theme-primary-rgb), 0.03)",
    "--ap-meter": "var(--theme-primary)",
    "--ap-prose-font": "inherit",
    "--ap-prose-size": "13.5px",
    "--ap-prose-lh": "1.6",
    "--ap-role-transform": "none",
    "--ap-role-tracking": "0",
    "--ap-syn-keyword": "#c792ea",
    "--ap-syn-string": "#c3e88d",
    "--ap-syn-number": "#f78c6c",
    "--ap-syn-comment": "#7d8b9e",
    "--ap-syn-function": "#82aaff",
    "--ap-syn-type": "#ffcb6b",
    "--ap-syn-tag": "#f07178",
    "--ap-syn-attr": "#c3e88d",
    "--ap-syn-punctuation": "#89a0b5",
    "--ap-lang-json": "#e2b15a",
    "--ap-lang-powershell": "#5b9dff",
    "--ap-lang-html": "#f07178",
    "--ap-accent-ink": "#0a0f14",
  };
}

export const DEFAULT_PANEL_THEME_ID = "neon-log";

export const PANEL_THEMES: PanelTheme[] = THEME_DEFINITIONS.map((def) => ({
  ...def,
  vars: def.id === "tabby" ? tabbyVars() : buildVars(def),
}));

export function findPanelTheme(id?: string): PanelTheme {
  return (
    PANEL_THEMES.find((theme) => theme.id === id) ??
    PANEL_THEMES.find((theme) => theme.id === DEFAULT_PANEL_THEME_ID) ??
    PANEL_THEMES[0]
  );
}

export function isPanelThemeId(id: unknown): id is string {
  return typeof id === "string" && PANEL_THEMES.some((theme) => theme.id === id);
}
