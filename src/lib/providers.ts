/**
 * Провайдеры моделей.
 *
 * Каждый провайдер — это тройка «base URL + id модели + свой API-ключ». Ключи
 * хранятся в общих настройках, поэтому переключение провайдера сразу применяет
 * его ключ и больше не нужно вписывать его руками. Список произвольный: в
 * настройках можно добавить сколько угодно провайдеров.
 */

export interface AIProviderConfig {
  /** Стабильный id (используется как ключ хранения). */
  id: string;
  /** Отображаемое имя. */
  label: string;
  /** Base URL OpenAI-совместимого API (путь /v1 добавляется автоматически). */
  endpoint: string;
  /** Идентификатор модели. */
  model: string;
  /** Bearer-токен именно этого провайдера. */
  apiToken: string;
  /** Контекстное окно (0/undefined — определить автоматически). */
  contextWindowTokens?: number;
}

/**
 * Встроенный список провайдеров пуст: плагин не поставляет ни endpoint'ов, ни
 * ключей. Пользователь добавляет свои провайдеры в настройках, у каждого свой
 * API-ключ. Так в репозиторий и в чужие конфиги не попадают ни секреты, ни
 * приватные адреса.
 */
export const DEFAULT_PROVIDERS: AIProviderConfig[] = [];

/** Провайдер по умолчанию (нет — пока пользователь не добавит своего). */
export const DEFAULT_PROVIDER_ID = "";

export function cloneProviders(
  providers: AIProviderConfig[] = DEFAULT_PROVIDERS,
): AIProviderConfig[] {
  return providers.map((provider) => ({ ...provider }));
}

export function findProvider(
  providers: AIProviderConfig[] | undefined,
  id: string | null | undefined,
): AIProviderConfig | undefined {
  if (!providers?.length || !id) {
    return undefined;
  }
  return providers.find((provider) => provider.id === id);
}

/** Уникальный id для нового пользовательского провайдера. */
export function createProviderId(
  providers: AIProviderConfig[] | undefined,
): string {
  const existing = new Set((providers ?? []).map((provider) => provider.id));
  let index = (providers?.length ?? 0) + 1;
  let id = `provider-${index}`;
  while (existing.has(id)) {
    index += 1;
    id = `provider-${index}`;
  }
  return id;
}
