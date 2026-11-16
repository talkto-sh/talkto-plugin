/**
 * The TalkTo side of the plugin: the `get_updates` reply decoded into what a
 * notice needs. A hooks module imports only its own files, so this decodes the
 * server's JSON by hand; anything that does not match is a failure, never a
 * guess.
 */

/** One incoming message, as much as a notice shows. */
export interface IncomingMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly createdAt: string;
  readonly body: string;
  readonly isUrgent: boolean;
  /** "#general" or "direct chat with planner". */
  readonly where: string;
  /** "planner (codex)", or the sender ID when the reply did not describe it. */
  readonly from: string;
}

/** Who renamed a participant: itself (an agent operation for it) or a person, by name. */
export type RenamedBy =
  | { readonly kind: "self" }
  | { readonly kind: "person"; readonly name: string };

/**
 * One participant's name change. The participant keeps its ID; only its name on the server changed.
 */
export interface ParticipantRename {
  readonly id: string;
  readonly participantId: string;
  readonly previousName: string;
  readonly name: string;
  /** Who made the change, or null when the server named nobody this plugin understands. */
  readonly by: RenamedBy | null;
}

/** One `get_updates` page. */
export interface UpdatesPage {
  readonly messages: ReadonlyArray<IncomingMessage>;
  /** Renames since the checkpoint; empty from a server that does not send them. */
  readonly renames: ReadonlyArray<ParticipantRename>;
  readonly checkpoint: string;
  readonly hasMore: boolean;
  /**
   * The person's wake cadence: start an idle turn for normal messages at most this often. Null
   * from a server that does not send it, which keeps the old behavior.
   */
  readonly wakeIntervalSeconds: number | null;
  /**
   * The newest published version of this plugin, as in "0.3.0", when the call named the plugin
   * and the server knows it. Null from a server that does not send it.
   */
  readonly latestPluginVersion: string | null;
}

/** A plugin version: three numbers, as in "0.3.0". */
export const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** A failed call: TalkTo's error code and message, or `transport` when the call itself failed. */
export interface UpdatesFailure {
  readonly code: string;
  readonly message: string;
}

/** What an MCP tools/call answered, as the host hands it over. */
export interface ToolAnswer {
  readonly isError: boolean;
  readonly structuredContent?: unknown;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

export type UpdatesReply =
  | { readonly kind: "page"; readonly page: UpdatesPage }
  | { readonly kind: "failure"; readonly failure: UpdatesFailure };

/** An object's own fields; reading through a map needs no assertion about its shape. */
export type Fields = ReadonlyMap<string, unknown>;
export const isObject = (value: unknown): value is object =>
  value !== null && Object(value) === value;
export const isText = (value: unknown): value is string => String(value) === value;
/** The object under `key`, as fields, or null when it is absent or not an object. */
export const fieldsAt = (fields: Fields, key: string): Fields | null => {
  const found = fields.get(key);
  return isObject(found) ? new Map(Object.entries(found)) : null;
};
export const textOf = (fields: Fields, key: string): string | null => {
  const found = fields.get(key);
  return isText(found) ? found : null;
};
export const listOf = (fields: Fields, key: string): ReadonlyArray<unknown> => {
  const found = fields.get(key);
  return Array.isArray(found) ? found : [];
};

/** The reply envelope: structured content when the server declared it, else the first text block. */
const envelopeOf = (answer: ToolAnswer): Fields | null => {
  if (isObject(answer.structuredContent)) return new Map(Object.entries(answer.structuredContent));
  const text = answer.content.find((block) => block.type === "text")?.text;
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? new Map(Object.entries(parsed)) : null;
  } catch {
    return null;
  }
};

const failure = (code: string, message: string): UpdatesReply => ({
  kind: "failure",
  failure: { code, message },
});

/**
 * The IDs of the messages one answer showed the agent: `data.messages` of a `get_updates` page,
 * or `data.items` of a `read_messages` page. Empty for an error or anything else.
 */
export const messageIdsOf = (answer: ToolAnswer): ReadonlyArray<string> => {
  if (answer.isError) return [];
  const envelope = envelopeOf(answer);
  const data = envelope === null ? null : fieldsAt(envelope, "data");
  if (data === null) return [];
  return [...listOf(data, "messages"), ...listOf(data, "items")].flatMap((entry) => {
    if (!isObject(entry)) return [];
    const id = textOf(new Map(Object.entries(entry)), "id");
    return id === null ? [] : [id];
  });
};

/**
 * The page's renames, read leniently: the field is additive, so an entry this plugin cannot read
 * is skipped rather than failing the page and its messages.
 */
const renamesOf = (data: Fields): ReadonlyArray<ParticipantRename> =>
  listOf(data, "renames").flatMap((entry): ReadonlyArray<ParticipantRename> => {
    if (!isObject(entry)) return [];
    const item: Fields = new Map(Object.entries(entry));
    const id = textOf(item, "id"),
      participantId = textOf(item, "participantId"),
      previousName = textOf(item, "previousName"),
      name = textOf(item, "name");
    if (id === null || participantId === null || previousName === null || name === null) return [];
    const actor = fieldsAt(item, "renamedBy");
    const kind = actor === null ? null : textOf(actor, "kind");
    const person = actor === null ? null : textOf(actor, "name");
    const by: RenamedBy | null =
      kind === "self"
        ? { kind: "self" }
        : kind === "person" && person !== null
          ? { kind: "person", name: person }
          : null;
    return [{ id, participantId, previousName, name, by }];
  });

/** Longest part of an error's text a failure keeps. */
const reasonLimit = 300;

/**
 * Decode one `get_updates` answer for `participantId`, naming senders and conversations from `included`.
 * An error answer that is not TalkTo's own (the host refused the reply, for example) keeps the host's
 * words, so the agent can be told what failed.
 */
export const decodeUpdates = (answer: ToolAnswer, participantId: string): UpdatesReply => {
  const envelope = envelopeOf(answer);
  if (envelope === null) {
    const said = answer.isError
      ? answer.content.find((block) => block.type === "text")?.text?.trim()
      : undefined;
    return failure(
      "unreadable",
      said === undefined || said === ""
        ? "TalkTo answered with no readable result."
        : said.slice(0, reasonLimit),
    );
  }
  const error = fieldsAt(envelope, "error");
  if (error !== null)
    return failure(
      textOf(error, "code") ?? "unknown",
      textOf(error, "message") ?? "TalkTo reported an error.",
    );
  const data = fieldsAt(envelope, "data");
  const checkpoint = data === null ? null : textOf(data, "checkpoint");
  if (data === null || checkpoint === null)
    return failure("unreadable", "TalkTo answered without a checkpoint.");
  const included = fieldsAt(envelope, "included");
  const names = new Map<string, string>();
  for (const entry of included === null ? [] : listOf(included, "participants")) {
    if (!isObject(entry)) continue;
    const item: Fields = new Map(Object.entries(entry));
    const id = textOf(item, "id"),
      name = textOf(item, "name"),
      type = textOf(item, "agentType");
    if (id !== null && name !== null) names.set(id, type === null ? name : `${name} (${type})`);
  }
  const places = new Map<string, string>();
  for (const entry of included === null ? [] : listOf(included, "conversations")) {
    if (!isObject(entry)) continue;
    const item: Fields = new Map(Object.entries(entry));
    const id = textOf(item, "id");
    if (id === null) continue;
    const name = textOf(item, "name");
    if (name !== null) {
      places.set(id, `#${name}`);
      continue;
    }
    const other = listOf(item, "participantIds").find(
      (member): member is string => isText(member) && member !== participantId,
    );
    const otherName = other === undefined ? undefined : names.get(other)?.replace(/ \(.*\)$/, "");
    places.set(id, otherName === undefined ? "a direct chat" : `direct chat with ${otherName}`);
  }
  const messages: IncomingMessage[] = [];
  for (const entry of listOf(data, "messages")) {
    if (!isObject(entry))
      return failure("unreadable", "TalkTo answered with an unreadable message.");
    const item: Fields = new Map(Object.entries(entry));
    const id = textOf(item, "id"),
      conversationId = textOf(item, "conversationId"),
      senderId = textOf(item, "senderId"),
      createdAt = textOf(item, "createdAt"),
      body = textOf(item, "body");
    if (
      id === null ||
      conversationId === null ||
      senderId === null ||
      createdAt === null ||
      body === null
    )
      return failure("unreadable", "TalkTo answered with an incomplete message.");
    messages.push({
      id,
      conversationId,
      senderId,
      createdAt,
      body,
      isUrgent: textOf(item, "priority") === "urgent",
      where: places.get(conversationId) ?? `conversation ${conversationId}`,
      from: names.get(senderId) ?? `participant ${senderId}`,
    });
  }
  const interval = data.get("wakeIntervalSeconds");
  const latest = textOf(data, "latestPluginVersion");
  return {
    kind: "page",
    page: {
      messages,
      renames: renamesOf(data),
      checkpoint,
      hasMore: textOf(data, "nextCursor") !== null,
      wakeIntervalSeconds:
        Number.isSafeInteger(interval) && Number(interval) >= 0 && Number(interval) <= 86_400
          ? Number(interval)
          : null,
      latestPluginVersion: latest !== null && versionPattern.test(latest) ? latest : null,
    },
  };
};

/**
 * The capabilities a `get_context` answer names (`data.capabilities`, as in "transfers"); empty for
 * an error or an answer that names none.
 */
export const capabilitiesOf = (answer: ToolAnswer): ReadonlyArray<string> => {
  if (answer.isError) return [];
  const envelope = envelopeOf(answer);
  const data = envelope === null ? null : fieldsAt(envelope, "data");
  return data === null ? [] : listOf(data, "capabilities").filter(isText);
};

/** The server's name from a `get_context` answer (`data.server.name`), or null when it is absent. */
export const serverNameOf = (answer: ToolAnswer): string | null => {
  if (answer.isError) return null;
  const envelope = envelopeOf(answer);
  const data = envelope === null ? null : fieldsAt(envelope, "data");
  const server = data === null ? null : fieldsAt(data, "server");
  return server === null ? null : textOf(server, "name");
};

/**
 * The server's General channel from a `get_context` answer (`data.server.generalConversationId`),
 * or null for an error or any answer that does not name it.
 */
export const generalIdOf = (answer: ToolAnswer): string | null => {
  if (answer.isError) return null;
  const envelope = envelopeOf(answer);
  const data = envelope === null ? null : fieldsAt(envelope, "data");
  const server = data === null ? null : fieldsAt(data, "server");
  return server === null ? null : textOf(server, "generalConversationId");
};
