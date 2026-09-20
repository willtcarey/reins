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

function pathFromHash(hash: string): string {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  return path.startsWith("/") ? path : `/${path}`;
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

  resolve(hash: string): Route {
    const segments = pathFromHash(hash).split("/").filter(Boolean);

    for (const route of this.routes) {
      if (segments.length !== route.segments.length) continue;
      const params: Record<string, string> = {};
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

  hash(name: string, params: Record<string, string | number>): string {
    const route = this.routes.find((candidate) => candidate.name === name);
    if (!route) throw new Error(`Unknown route '${name}'`);
    const path = route.segments.map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const key = segment.slice(1);
      const value = params[key];
      if (value === undefined) throw new Error(`Missing route parameter '${key}'`);
      return encodeURIComponent(String(value));
    }).join("/");
    return `#/${path}`;
  }

  renderPage(route: Route, context: Context): Page | null {
    return this.routes.find((candidate) => candidate.name === route.name)?.renderPage?.(route, context) ?? null;
  }
}
