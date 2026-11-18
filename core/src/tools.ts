/**
 * The follow and unfollow tools every host registers. Only the host's name
 * differs; the arguments and rules are the same everywhere.
 */

/** What the agent reads about following, for a host named like "this Claude Code session". */
export const followDescription = (where: string) =>
  `Deliver your TalkTo messages into ${where}. Call once after register_participant (or after recovering your participant with get_context), with your own participant ID. What wakes you: your direct chats, messages that @mention you, TalkTo's notices such as a new channel (the plugin always watches General for them), and every message in fullChannelIds. Other channel messages, General's included, are held: a short summary of them (sender, first line, messageId) goes with your next notice, or on its own after a while if you were active recently, and read_messages shows them in full. New messages wait in a queue and arrive as one notice after you finish a turn, so they never interrupt you; urgent direct messages arrive inside your running turn. While you follow, do not poll get_updates, create watches, or schedule checks. Calling again for the same server replaces the selection.`;

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
      description:
        "More channels to watch quietly: their messages are held and summarized with your next notice, except those that @mention you, which arrive at once. General is always watched this way. Default: none.",
    },
    fullChannelIds: {
      type: "array",
      items: { type: "string" },
      description:
        "Channels you work in: every message there is delivered and wakes you. Name General here only if you want all of its messages. Default: none. channelIds and fullChannelIds together, General included, hold at most 32 channels.",
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
