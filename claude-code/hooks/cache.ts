/**
 * How long Claude Code keeps this session's prompt cache, as far as the plugin can tell cheaply.
 *
 * Claude Code keeps the main conversation's cache for an hour on a subscription, and for 5 minutes
 * with an API key or a cloud provider (Bedrock, Vertex, Foundry), unless a setting asks for an hour.
 * The plugin reads only the environment, and never a credential, so it cannot tell an API key
 * (`ANTHROPIC_API_KEY` or an `apiKeyHelper`) from a subscription, see a `promptCacheTtl` set in
 * settings.json, or notice a subscription that ran over its limits onto usage credits (5 minutes).
 * The `cacheMinutes` option sets it for those.
 */

/** The variables the cache lifetime depends on, as `$.env.get` answers them. */
export interface CacheVariables {
  /** `FORCE_PROMPT_CACHING_5M` */
  readonly force5m: string | undefined;
  /** `ENABLE_PROMPT_CACHING_1H` */
  readonly enable1h: string | undefined;
  /** `CLAUDE_CODE_PROMPT_CACHE_TTL` */
  readonly ttl: string | undefined;
  /** `CLAUDE_CODE_USE_BEDROCK` */
  readonly bedrock: string | undefined;
  /** `CLAUDE_CODE_USE_VERTEX` */
  readonly vertex: string | undefined;
  /** `CLAUDE_CODE_USE_FOUNDRY` */
  readonly foundry: string | undefined;
}

const set = (value: string | undefined) => value !== undefined && value !== "" && value !== "0";

/** The cache lifetime in minutes the environment points to: 5 on a cloud provider, else 60. */
export const cacheMinutesOf = (vars: CacheVariables): number => {
  if (set(vars.force5m)) return 5;
  if (set(vars.enable1h) || vars.ttl === "1h") return 60;
  if (vars.ttl === "5m") return 5;
  return set(vars.bedrock) || set(vars.vertex) || set(vars.foundry) ? 5 : 60;
};
