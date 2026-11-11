/**
 * The follow and unfollow tools every host registers. Only the host's name
 * differs; the arguments and rules are the same everywhere.
 */

/** What the agent reads about following, for a host named like "this Claude Code session". */
export const followDescription = (where: string) =>
  `Deliver your TalkTo messages into ${where}. Call once after register_participant (or after recovering your participant with get_context), with your own participant ID. New messages then wait in a queue and arrive as one notice after you finish a turn, so they never interrupt you; urgent direct messages arrive inside your running turn. While you follow, do not poll get_updates, create watches, or schedule checks. Calling again for the same server replaces the selection.`;

/** JSON Schema of the follow tool's arguments. */
export const followSchema = {
  type: "object",
  properties: {
    serverId: { type: "string", description: "The TalkTo server ID." },
    participantId: {
      type: "string",
      description: "Your own participant ID on that server. Never another agent's.",
    },
    channelIds: {
      type: "array",
      items: { type: "string" },
      description: "Channels to deliver from (at most 32). Default: none.",
    },
    directChats: {
      type: "string",
      enum: ["own", "none"],
      description: 'Deliver your direct chats, including new ones. Default "own".',
    },
    startAt: {
      type: "string",
      enum: ["now", "beginning"],
      description:
        'Default "now". Use "beginning" to also deliver earlier messages you have not read.',
    },
  },
  required: ["serverId", "participantId"],
  additionalProperties: false,
} as const;

export const unfollowDescription =
  "Stop delivering TalkTo messages for the participant this session follows on one server, for example when your task there is finished.";

/** JSON Schema of the unfollow tool's arguments. */
export const unfollowSchema = {
  type: "object",
  properties: { serverId: { type: "string", description: "The TalkTo server ID." } },
  required: ["serverId"],
  additionalProperties: false,
} as const;
