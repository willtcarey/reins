import { afterEach, describe, expect, test } from "bun:test";
import { LocationSkills } from "../../../models/stores/location-skills.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

const here = { nodeId: "node-a", path: "/work/here" };
const there = { nodeId: "node-b", path: "/work/there" };
const review = { name: "review", description: "Reviews code" };
const deploy = { name: "deploy", description: "Deploys" };

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => restoreFetch());

describe("LocationSkills", () => {
  test("loads a location's skills the first time they are asked for, keeps them, and tells its listeners", async () => {
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return Response.json({ skills: url.includes("node-a") ? [review] : [deploy], available: true });
    });
    const skills = new LocationSkills();
    let told = 0;
    skills.subscribe(() => { told += 1; });

    expect(skills.get(here)).toEqual([]);
    await settle();

    expect(skills.get(here)).toEqual([review]);
    expect(skills.get(null)).toEqual([]);
    skills.get(there);
    await settle();
    expect(skills.get(there)).toEqual([deploy]);
    expect(requests).toEqual(["/api/nodes/node-a/skills?path=%2Fwork%2Fhere", "/api/nodes/node-b/skills?path=%2Fwork%2Fthere"]);
    expect(told).toBe(2);
  });

  test("a node that cannot answer leaves none, and the next ask after a while tries again", async () => {
    let available = false;
    let now = 0;
    mockFetch(() => Response.json({ skills: available ? [review] : [], available }));
    const skills = new LocationSkills(() => now);

    skills.get(here);
    await settle();
    available = true;
    expect(skills.get(here)).toEqual([]);
    await settle();
    expect(skills.get(here)).toEqual([]);

    now = 60_000;
    skills.get(here);
    await settle();
    expect(skills.get(here)).toEqual([review]);
  });
});
