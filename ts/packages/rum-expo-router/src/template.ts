/**
 * The view name of an Expo Router route (decision N22): "/" and the file segments useSegments()
 * returns joined by "/", groups such as (studio) and placeholders such as [projectId] kept, a
 * trailing index dropped. Never the pathname, which can carry IDs. An unmatched path is named
 * after the app's +not-found route, as the router reports it: /+not-found.
 */
export function routeTemplate(segments: readonly string[]): string {
  const last = segments.length - 1;
  const parts = segments.filter((s, i) => s !== "" && !(s === "index" && i === last));
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}
