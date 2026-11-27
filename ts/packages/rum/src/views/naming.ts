/**
 * The view name when no router adapter names the view (decision P17): the path, with every
 * segment that holds a digit or is longer than 24 characters replaced by $id. Query and fragment
 * are dropped, so a raw URL never becomes a view name.
 */
export function defaultViewName(url: URL): string {
  const path = url.pathname
    .split("/")
    .map((s) => (s !== "" && (/\d/.test(s) || s.length > 24) ? "$id" : s))
    .join("/");
  return path === "" ? "/" : path;
}
