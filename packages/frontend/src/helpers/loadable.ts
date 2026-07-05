export type LoadableStatus = "idle" | "loading" | "loaded" | "error";

export class Loadable<T> {
  private constructor(
    public readonly status: LoadableStatus,
    public readonly data: T | null,
    public readonly loading: boolean,
    public readonly error: string | null,
  ) {}

  static idle<T>(): Loadable<T> {
    return new Loadable<T>("idle", null, false, null);
  }

  asLoading(): Loadable<T> {
    return new Loadable<T>("loading", this.data, true, null);
  }

  asLoaded(data: T): Loadable<T> {
    return new Loadable<T>("loaded", data, false, null);
  }

  asError(error: string): Loadable<T> {
    return new Loadable<T>("error", this.data, false, error);
  }
}
