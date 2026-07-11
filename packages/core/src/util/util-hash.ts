import { createHash } from "node:crypto";

export function hashQuery(query: string): string {
  return createHash("sha1").update(query).digest("hex").slice(0, 8);
}
