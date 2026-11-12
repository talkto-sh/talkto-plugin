/**
 * The part of OpenClaw's native plugin API this plugin uses (OpenClaw 2026.11.3,
 * `openclaw/plugin-sdk`: `OpenClawPluginApi` in `src/plugins/plugin-api.types.ts`). Declared here
 * so the plugin needs no OpenClaw package to type-check or to run; OpenClaw's own objects satisfy
 * these shapes (`OpenClawPluginApi` from 2026.11.3 is assignable to `Api`; see README).
 */

/** The tool arguments the plugin reads: TalkTo's tools name their server and participant. */
export interface ToolParams {
  readonly serverId?: unknown;
  readonly participantId?: unknown;
}
/** `after_tool_call`: a finished tool call, MCP tools included (`<server>__<tool>`). */
export interface ToolHookEvent {
  readonly toolName: string;
  readonly params: ToolParams;
  readonly runId?: string;
  readonly toolCallId?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly durationMs?: number;
}
export interface ToolHookContext {
  readonly agentId?: string;
  readonly sessionKey?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly toolName: string;
}

export type SessionEndReason =
  | "new"
  | "reset"
  | "idle"
  | "daily"
  | "compaction"
  | "deleted"
  | "shutdown"
  | "restart"
  | "unknown";
export interface SessionEndEvent {
  readonly sessionId: string;
  readonly sessionKey?: string;
  readonly reason?: SessionEndReason;
}
export interface SessionContext {
  readonly agentId?: string;
  readonly sessionId: string;
  readonly sessionKey?: string;
}

/** A sanitized agent event; lifecycle events carry `data.phase` "start", "end" or "error". */
export interface AgentEvent {
  readonly runId: string;
  readonly stream: string;
  readonly data: { readonly phase?: unknown };
  readonly sessionKey?: string;
  readonly agentId?: string;
}
export interface AgentEventSubscription {
  readonly id: string;
  readonly description?: string;
  readonly streams?: Array<string>;
  readonly phases?: Array<string>;
  readonly payload?: "full" | "metadata";
  readonly handle: (event: AgentEvent) => void | Promise<void>;
}

/** `api.session.workflow.steerActiveRun`: hidden plugin guidance for the session's running turn. */
export interface SteerParams {
  readonly sessionKey: string;
  readonly text: string;
  readonly idempotencyKey?: string;
}
export type SteerResult =
  | { readonly steered: true; readonly runId?: string }
  | { readonly steered: false; readonly reason: string };

/** `api.runtime.system.enqueueSystemEvent`: a `System:` line for the session's next turn. */
export interface SystemEventOptions {
  readonly sessionKey: string;
  readonly agentId?: string;
  readonly contextKey?: string | null;
  /** Replace the pending event with the same contextKey. */
  readonly replace?: boolean;
}
/** `api.runtime.system.requestHeartbeat`: start a turn for the queued events now. */
export interface HeartbeatRequest {
  readonly source: "other";
  readonly intent: "immediate";
  readonly reason?: string;
  readonly agentId?: string;
  readonly sessionKey?: string;
}

/** `api.runtime.state.openKeyedStoreV2`: plugin-scoped SQLite rows that survive restarts. */
export interface KeyedStore<T> {
  register(key: string, value: T, options?: { readonly ttlMs?: number }): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<ReadonlyArray<{ readonly key: string; readonly value: T }>>;
}
export interface KeyedStoreOptions {
  readonly namespace: string;
  readonly maxEntries: number;
  readonly defaultTtlMs?: number;
}

export interface Service {
  readonly id: string;
  readonly start: () => void | Promise<void>;
  readonly stop?: () => void | Promise<void>;
}

export interface CommandContext {
  readonly channel: string;
  readonly agentId?: string;
  readonly sessionKey?: string;
}
export interface CommandResult {
  readonly text?: string;
}
export interface Command {
  readonly name: string;
  readonly description: string;
  readonly acceptsArgs?: boolean;
  /** Text added to the agent's system prompt while the command is registered. */
  readonly agentPromptGuidance?: ReadonlyArray<string>;
  readonly handler: (ctx: CommandContext) => CommandResult | Promise<CommandResult>;
}

export interface Logger {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
}

/** `plugins.entries.talkto-plugin.config`, as the person wrote it; see `openclaw.plugin.json`. */
export interface PluginConfig {
  readonly delivery?: unknown;
  readonly urgent?: unknown;
  readonly pollSeconds?: unknown;
}

export interface Api {
  readonly id: string;
  readonly pluginConfig?: PluginConfig;
  readonly logger: Logger;
  readonly runtime: {
    readonly system: {
      readonly enqueueSystemEvent: (text: string, options: SystemEventOptions) => boolean;
      readonly requestHeartbeat: (request: HeartbeatRequest) => void;
    };
    readonly state: {
      readonly openKeyedStoreV2: <T>(options: KeyedStoreOptions) => KeyedStore<T>;
    };
  };
  readonly session: {
    readonly workflow: {
      readonly steerActiveRun: (params: SteerParams) => Promise<SteerResult>;
    };
  };
  readonly agent: {
    readonly events: {
      readonly registerAgentEventSubscription: (subscription: AgentEventSubscription) => void;
    };
  };
  on(
    hook: "after_tool_call",
    handler: (event: ToolHookEvent, ctx: ToolHookContext) => void | Promise<void>,
  ): void;
  on(
    hook: "session_end",
    handler: (event: SessionEndEvent, ctx: SessionContext) => void | Promise<void>,
  ): void;
  readonly registerService: (service: Service) => void;
  readonly registerCommand: (command: Command) => void;
}

/** What `openclaw.extensions` points at: OpenClaw calls `register` once per plugin load. */
export interface PluginEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly register: (api: Api) => void;
}
