/** True for requests the static website should answer: GET/HEAD outside /api. */
export function isWebsiteRequest(method: string, urlPath: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return !(urlPath === "/api" || urlPath.startsWith("/api/"));
}
