// An added extension's backend source, which the tests bundle as its author would: TypeBox inside it, a
// copy apart from the server's.
import { Type } from "@sinclair/typebox";

const api = { hello: { input: Type.Object({ name: Type.String() }), output: Type.String() } };

export default {
  register: (reins: { http: { handle(api: object, handlers: object): () => void } }) =>
    reins.http.handle(api, { hello: ({ input }: { input: { name: string } }) => `Hello, ${input.name}` }),
};
