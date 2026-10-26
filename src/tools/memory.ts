import {
  CommandError,
  MEMORY_KINDS,
  MEMORY_MODES,
  MEMORY_SCOPES,
  MEMORY_SEARCH_LIMIT_MAX,
  deleteMemory,
  getMemoryMode,
  listMemories,
  saveMemory,
  searchMemories,
  setMemoryMode,
  updateMemory,
  type Config,
  type MemoryItem,
} from "mergestorm/client";
import { z } from "zod";
import type { ToolPayload } from "./types.js";

const memoryId = z.string().uuid();
const memoryText = z.string().trim().min(1).max(500);
const repo = z.string().trim().min(3).max(200);

export const listMemoriesSchema = {
  scope: z.enum(MEMORY_SCOPES).optional(),
  repo: repo.optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
};
export const searchMemorySchema = {
  query: z.string().trim().min(1).max(2000),
  repo: repo.optional(),
  limit: z.number().int().min(1).max(MEMORY_SEARCH_LIMIT_MAX).optional(),
};
export const rememberSchema = { text: memoryText, kind: z.enum(MEMORY_KINDS), repo: repo.optional() };
export const updateMemorySchema = { id: memoryId, text: memoryText, kind: z.enum(MEMORY_KINDS).optional() };
export const forgetMemorySchema = { id: memoryId };
export const setMemoryModeSchema = { memory_mode: z.enum(MEMORY_MODES) };

export type MemoryApi = {
  listMemories: typeof listMemories;
  searchMemories: typeof searchMemories;
  saveMemory: typeof saveMemory;
  updateMemory: typeof updateMemory;
  deleteMemory: typeof deleteMemory;
  getMemoryMode: typeof getMemoryMode;
  setMemoryMode: typeof setMemoryMode;
};

const liveApi: MemoryApi = { listMemories, searchMemories, saveMemory, updateMemory, deleteMemory, getMemoryMode, setMemoryMode };

export function memoryLine(memory: MemoryItem): string {
  return `- [${memory.id}] (${memory.repo ? `${memory.kind}, ${memory.repo}` : memory.kind}) ${memory.text}`;
}

async function guarded(run: () => Promise<ToolPayload>): Promise<ToolPayload> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof CommandError ? err.code ?? "memory_failed" : "memory_failed";
    return {
      summary: message,
      data: { error: { code, message, ...(err instanceof CommandError && err.retryAfterSeconds !== undefined ? { retry_after_seconds: err.retryAfterSeconds } : {}) } },
      isError: true,
    };
  }
}

export function createMemoryToolHandlers(cfg: Config | undefined, chatId: string | null, api: MemoryApi = liveApi) {
  return {
    list: (input: { scope?: (typeof MEMORY_SCOPES)[number]; repo?: string; kind?: (typeof MEMORY_KINDS)[number] }) =>
      guarded(async () => {
        const listed = await api.listMemories(input, cfg);
        const count = listed.items.length === 1 ? "1 memory" : `${listed.items.length} memories`;
        return { summary: [`Memory is ${listed.memory_mode}. ${count}.`, ...listed.items.map(memoryLine)].join("\n"), data: listed };
      }),
    search: (input: { query: string; repo?: string; limit?: number }) =>
      guarded(async () => {
        const found = await api.searchMemories({ ...input, chatId }, cfg);
        const all = [...found.rules, ...found.items];
        const summary = found.memory_mode === "off"
          ? "Memory is off, so nothing was searched."
          : all.length === 0 ? "Nothing in memory matches." : ["Memories that match, best first:", ...all.map(memoryLine)].join("\n");
        return { summary, data: found };
      }),
    remember: (input: { text: string; kind: (typeof MEMORY_KINDS)[number]; repo?: string }) =>
      guarded(async () => {
        const saved = await api.saveMemory({ ...input, chatId }, cfg);
        return { summary: saved.merged ? `That matched memory ${saved.id}, which now says this.` : `Saved to memory as ${saved.id}.`, data: saved };
      }),
    update: (input: { id: string; text: string; kind?: (typeof MEMORY_KINDS)[number] }) =>
      guarded(async () => {
        const updated = await api.updateMemory(input.id, { text: input.text, ...(input.kind ? { kind: input.kind } : {}) }, cfg);
        return { summary: `Memory ${updated.id} updated.`, data: updated };
      }),
    forget: (input: { id: string }) =>
      guarded(async () => {
        const deleted = await api.deleteMemory(input.id, cfg);
        return { summary: `Memory ${deleted.id} forgotten.`, data: deleted };
      }),
    getMode: () =>
      guarded(async () => {
        const mode = await api.getMemoryMode(cfg);
        return { summary: `Memory is ${mode.memory_mode}.`, data: mode };
      }),
    setMode: (input: { memory_mode: (typeof MEMORY_MODES)[number] }) =>
      guarded(async () => {
        const mode = await api.setMemoryMode(input.memory_mode, cfg);
        return { summary: `Memory is now ${mode.memory_mode}.`, data: mode };
      }),
  };
}
