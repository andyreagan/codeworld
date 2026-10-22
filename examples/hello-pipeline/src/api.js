// The front door: one route that greets whoever asks.

import { format, validate } from "./text.js";
import { record } from "./log.js";

/**
 * Greet someone by name, and log that we did.
 * @route POST /greet
 * @example {"name": "ada lovelace"}
 */
export function greet(body) {
  const name = validate(body);
  const message = format(name);
  record(message);
  return { message };
}
