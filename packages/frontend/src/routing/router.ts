/** Generic registered route matching and page rendering. */

export interface Route {
  name: string;
  params: Readonly<Record<string, string>>;
}

export interface RouteRegistration<Context = never, Page = never> {
  name: string;
  pattern: string;
  validate?: (params: Readonly<Record<string, string>>) => boolean;
  renderPage?: (route: Route, context: Context) => Page;
}

interface CompiledRoute<Context, Page> extends RouteRegistration<Context, Page> {
  segments: string[];
}

const EMPTY_ROUTE: Route = { name: "empty", params: {} };

/** The path and the query of a hash. */
function splitHash(hash: string): { path: string; query: URLSearchParams } {
  const [rawPath = "", query = ""] = (hash.startsWith("#") ? hash.slice(1) : hash).split("?", 2);
  return { path: rawPath.startsWith("/") ? rawPath : `/${rawPath}`, query: new URLSearchParams(query) };
}

export class FrontendRouter<Context = never, Page = never> {
  private routes: CompiledRoute<Context, Page>[] = [];

  register(registration: RouteRegistration<Context, Page>): () => void {
    if (this.routes.some((route) => route.name === registration.name)) {
      throw new Error(`Route '${registration.name}' is already registered`);
    }
    const route = { ...registration, segments: registration.pattern.split("/").filter(Boolean) };
    this.routes.push(route);
    return () => {
      this.routes = this.routes.filter((candidate) => candidate !== route);
    };
  }

  /** A hash's route; its query's parameters are the route's too, under the path's of the same name. */
  resolve(hash: string): Route {
    const { path, query } = splitHash(hash);
    const segments = path.split("/").filter(Boolean);

    for (const route of this.routes) {
      if (segments.length !== route.segments.length) continue;
      const params: Record<string, string> = Object.fromEntries(query);
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const patternSegment = route.segments[index];
        const value = segments[index];
        if (patternSegment?.startsWith(":")) {
          try {
            params[patternSegment.slice(1)] = decodeURIComponent(value ?? "");
          } catch {
            matched = false;
            break;
          }
        } else if (patternSegment !== value) {
          matched = false;
          break;
        }
      }
      if (matched && (!route.validate || route.validate(params))) {
        return { name: route.name, params };
      }
    }

    return EMPTY_ROUTE;
  }

  /** The route's hash; the parameters its pattern does not name go in the query. */
  hash(name: string, params: Record<string, string | number>): string {
    const route = this.routes.find((candidate) => candidate.name === name);
    if (!route) throw new Error(`Unknown route '${name}'`);
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    const path = route.segments.map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const key = segment.slice(1);
      const value = params[key];
      if (value === undefined) throw new Error(`Missing route parameter '${key}'`);
      query.delete(key);
      return encodeURIComponent(String(value));
    }).join("/");
    return query.size > 0 ? `#/${path}?${query}` : `#/${path}`;
  }

  renderPage(route: Route, context: Context): Page | null {
    return this.routes.find((candidate) => candidate.name === route.name)?.renderPage?.(route, context) ?? null;
  }
}
