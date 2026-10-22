// Text helpers: checking and dressing up names.

/** Pull a usable name out of a request body, or refuse. */
export function validate(body) {
  if (!body || typeof body.name !== "string") throw new Error("name is required");
  const name = body.name.trim();
  if (name.length === 0) throw new Error("name is empty");
  if (name.length > 60) throw new Error("name is too long");
  return name;
}

/** "ada lovelace" -> "Hello, Ada Lovelace!" */
export function format(name) {
  return `Hello, ${name.split(/\s+/).map(capitalize).join(" ")}!`;
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
