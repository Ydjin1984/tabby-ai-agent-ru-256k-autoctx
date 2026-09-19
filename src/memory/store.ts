/**
 * Persistence for the memory layer.
 *
 * No native dependencies: the default store is a single JSON document written
 * atomically to disk. [[MemoryDatabase]] keeps the hot copy in memory and
 * debounces writes so command-by-command observation stays cheap.
 */

import * as fs from "fs";
import * as path from "path";
import { MemoryEntry, MemoryType } from "./types";

export interface MemoryStore {
  load(): Promise<MemoryEntry[]>;
  save(entries: MemoryEntry[]): Promise<void>;
  /** Пометить id как удалённые этим процессом, чтобы [[JsonFileStore.save]] не вернул их из файла. */
  forget?(ids: string[]): void;
}

export class InMemoryStore implements MemoryStore {
  private entries: MemoryEntry[];

  constructor(initial: MemoryEntry[] = []) {
    this.entries = initial;
  }

  async load(): Promise<MemoryEntry[]> {
    return this.entries;
  }

  async save(entries: MemoryEntry[]): Promise<void> {
    this.entries = entries;
  }
}

/**
 * JSON file store with atomic replace (write temp file, then rename) so a crash
 * mid-write cannot corrupt the memory database.
 *
 * It also protects against a second Tabby window: entries that appeared on disk
 * after this process loaded the file are folded back in on save instead of being
 * overwritten by our snapshot. Entries this process pruned on purpose are not
 * resurrected, because they were created before `loadedAt`.
 */
export class JsonFileStore implements MemoryStore {
  private filePath: string;
  /** When this process last loaded the file from disk. */
  private loadedAt = 0;
  /**
   * Id записей, которые этот процесс удалил сам. Без этого [[foldInForeignEntries]]
   * возвращал их обратно из файла (они созданы позже loadedAt), поэтому «Забыть»
   * в инспекторе, prune консолидации и clear() не давали эффекта.
   */
  private tombstones = new Set<string>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  forget(ids: string[]): void {
    for (const id of ids) {
      this.tombstones.add(id);
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  async load(): Promise<MemoryEntry[]> {
    const entries = await this.readEntries();
    this.loadedAt = Date.now();
    return entries;
  }

  async save(entries: MemoryEntry[]): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const payloadEntries = await this.foldInForeignEntries(entries);
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify({ version: 1, entries: payloadEntries }, null, 2);
    await fs.promises.writeFile(tempPath, payload, "utf8");
    await fs.promises.rename(tempPath, this.filePath);
  }

  /** Read the file without touching [[loadedAt]] (used from `save`). */
  private async readEntries(): Promise<MemoryEntry[]> {
    try {
      const raw = await fs.promises.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed as MemoryEntry[];
      }
      if (parsed && Array.isArray(parsed.entries)) {
        return parsed.entries as MemoryEntry[];
      }
      return [];
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return [];
      }
      // Повреждённый JSON (обрыв записи, ручная правка) не должен молча отключать
      // память навсегда: уводим файл в карантин и стартуем с пустой базы.
      try {
        await fs.promises.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
        console.warn(`Память агента: повреждённый файл перемещён в карантин: ${this.filePath}`);
      } catch (renameError) {
        console.warn("Память агента: файл памяти не читается и не перемещён.", error, renameError);
      }
      return [];
    }
  }

  private async foldInForeignEntries(entries: MemoryEntry[]): Promise<MemoryEntry[]> {
    if (!this.loadedAt) {
      return entries;
    }
    let onDisk: MemoryEntry[];
    try {
      onDisk = await this.readEntries();
    } catch {
      return entries;
    }
    if (!onDisk.length) {
      return entries;
    }
    const known = new Set(entries.map((entry) => entry.id));
    const foreign = onDisk.filter(
      (entry) =>
        !known.has(entry.id) &&
        !this.tombstones.has(entry.id) &&
        (entry.createdAt ?? 0) > this.loadedAt,
    );
    return foreign.length ? [...entries, ...foreign] : entries;
  }
}

export interface MemoryDatabaseOptions {
  store?: MemoryStore;
  persistDebounceMs?: number;
  onPersistError?: (error: unknown) => void;
}

export class MemoryDatabase {
  private entries: Map<string, MemoryEntry> = new Map();
  private store: MemoryStore;
  private persistDebounceMs: number;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private dirty = false;
  private onPersistError?: (error: unknown) => void;

  constructor(options: MemoryDatabaseOptions = {}) {
    this.store = options.store ?? new InMemoryStore();
    this.persistDebounceMs = options.persistDebounceMs ?? 750;
    this.onPersistError = options.onPersistError;
  }

  async load(): Promise<void> {
    const loaded = await this.store.load();
    this.entries = new Map(loaded.map((entry) => [entry.id, entry]));
  }

  all(): MemoryEntry[] {
    return Array.from(this.entries.values());
  }

  byType(type: MemoryType): MemoryEntry[] {
    return this.all().filter((entry) => entry.type === type);
  }

  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  size(): number {
    return this.entries.size;
  }

  upsert(entry: MemoryEntry): void {
    this.entries.set(entry.id, entry);
    this.markDirty();
  }

  upsertMany(entries: MemoryEntry[]): void {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
    if (entries.length > 0) {
      this.markDirty();
    }
  }

  remove(id: string): void {
    if (this.entries.delete(id)) {
      // Помечаем удаление, иначе следующий save прочитает запись из файла и вернёт её.
      this.store.forget?.([id]);
      this.markDirty();
    }
  }

  replaceAll(entries: MemoryEntry[]): void {
    const kept = new Set(entries.map((entry) => entry.id));
    const dropped = this.all()
      .filter((entry) => !kept.has(entry.id))
      .map((entry) => entry.id);
    // clear()/prune проходят через replaceAll: без tombstone выброшенные записи
    // воскресали из файла на следующем debounce-save.
    this.store.forget?.(dropped);
    this.entries = new Map(entries.map((entry) => [entry.id, entry]));
    this.markDirty();
  }

  markDirty(): void {
    this.dirty = true;
  }

  schedulePersist(): void {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, this.persistDebounceMs);
    // unref() убран намеренно: с ним Tabby успевал выйти из процесса раньше, чем
    // отрабатывал отложенный save, и последние наблюдения памяти терялись.
  }

  async persist(): Promise<void> {
    // Все записи строго последовательно: два параллельных сохранения одного файла
    // могли примениться в обратном порядке и вернуть старый снимок поверх нового.
    this.persistChain = this.persistChain.then(() => this.persistOnce());
    return this.persistChain;
  }

  private async persistOnce(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    try {
      await this.store.save(this.all());
    } catch (error) {
      this.dirty = true;
      this.onPersistError?.(error);
    }
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
    // Дожидаемся и записей, запущенных до нас: иначе «Забыть всё» могло вернуться
    // раньше, чем старый снимок лёг на диск.
    await this.persistChain;
  }
}
