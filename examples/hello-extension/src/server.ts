/** The backend part: runs in the Reins server, with its own database. Its build bundles all it uses. */
import type { ServerExtension, ServerSdk } from "@reins/sdk/server";
import { api } from "./api.js";

/** Greets `name`, counting how often it was greeted; tells browsers. */
export function greet(reins: Pick<ServerSdk, "db" | "broadcast">, name: string) {
  reins.db.query("INSERT INTO greetings (name) VALUES (?)").run(name);
  const { count } = reins.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM greetings WHERE name = ?").get(name) ?? { count: 0 };
  reins.broadcast({ type: "greeted", name });
  return { message: `Hello, ${name}!`, count };
}

export default {
  migrations: [
    { id: "001_greetings", up: db => db.exec("CREATE TABLE greetings (name TEXT NOT NULL)") },
  ],
  register(reins) {
    return reins.http.handle(api, {
      greet: ({ input }) => greet(reins, input.name),
    });
  },
} satisfies ServerExtension;
