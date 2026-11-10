/**
 * opencode 2.2.5's decision on whether a provider error is worth retrying, copied
 * from its bundled classifier (`yp` in the CLI) so tests can hold our error bodies
 * to it. A streamed error has no HTTP status, because the 200 went out with the
 * stream's headers; that is the case opencode hits, since it always streams.
 */
const RATE_LIMIT_TEXT = /rate increased too quickly|rate[-_\s]?limit|too[_\s]?many[_\s]?requests/i;
const RETRY_TEXT =
  /\b(?:try again|(?:please |you can )?retry (?:the |this |your )?request|try (?:the |this |your )?request again|(?:currently |temporarily )?at capacity|overloaded|temporarily unavailable|service[-_\s]?unavailable|(?:server|internal)[-_\s]?error|server (?:is )?busy|provider returned (?:an )?error|resource[-_\s]?exhausted|upstream (?:connect|connection|request))/i;
const RETRY_CODES = new Set([
  "api_error", "internal_error", "internalserverexception", "modelstreamerrorexception", "overloaded_error",
  "server_error", "server_is_overloaded", "slow_down", "serviceunavailableexception",
]);
const INVALID_REQUEST_CODES = new Set(["model_not_found", "invalid_prompt", "invalid_request", "invalid_request_error", "validationexception"]);

export function opencodeWouldRetry(status: number | undefined, body: { error: { message: string; code?: string; type?: string } }): boolean {
  const codes = [body.error.code, body.error.type].filter((c): c is string => Boolean(c)).map((c) => c.toLowerCase());
  const text = body.error.message;
  if (status === 429 || codes.some((c) => c.includes("rate_limit") || c === "too_many_requests" || c === "throttlingexception") || RATE_LIMIT_TEXT.test(text)) return true;
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) return true;
  if (status === undefined || status < 400) {
    if (!codes.some((c) => INVALID_REQUEST_CODES.has(c)) && RETRY_TEXT.test(text)) return true;
    if (codes.some((c) => RETRY_CODES.has(c) || c.includes("exhausted") || c.includes("unavailable"))) return true;
  }
  return false;
}
