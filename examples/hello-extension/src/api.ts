/** The backend part's HTTP API: what the frontend part calls with `reins.http.call`. Schemas only. */
import { Type } from "@sinclair/typebox";

export const api = {
  greet: {
    input: Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }) }),
    output: Type.Object({ message: Type.String(), count: Type.Number() }),
  },
};

export type Api = typeof api;
