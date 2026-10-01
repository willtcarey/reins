import { openingTarget } from "../helpers/loopback-node.js";
import { NODE_COMMAND_TIMEOUTS } from "../../node-link/node-hub.js";
import { nodeSession } from "../helpers/node-session.js";
import { directLink, drainCommands, loopbackNodeFor } from "../helpers/loopback-node.js";
import { test, expect, spyOn } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DeliveryDeferred, type NodeCommand } from "@reins/node-protocol";
import type { Node } from "@reins/node/node";
import { storedInput } from "../../pi-session-store.js";
import { enqueueInput, enqueueSetModel, getCommand, getNodeCommand } from "../../node-link/node-command-store.js";
import { recoverInterruptedDispatches } from "../../node-link/node-command-recovery.js";
import { deliverCommand } from "../../node-link/node-command-dispatcher.js";
import { sessionRoute } from "../../nodes/commands.js";

const text = (value: string) => [{ type: "text" as const, text: value }];
/** Admits a stored prompt/steer on the node directly, as a node crash right after Pi admission leaves it. */
const admitDirectly = (node: Node, command: NodeCommand) => {
  if (command.op !== "session.prompt" && command.op !== "session.steer") throw new Error(`Not an input: ${command.op}`);
  const input = { sessionId: command.sessionId, ...openingTarget(command.sessionId), clientId: command.clientId, content: command.content, sourceSessionId: command.sourceSessionId };
  return command.op === "session.prompt" ? node.prompt(input) : node.steer(input);
};

test("a prompt or setModel whose outcome is unknown is requeued, and its replay converges without a second admission", async () => {
  const { state, target, untilSettled, inputs, replies, provider, lane, dispose } = await nodeSession("wire-unknown", [fauxAssistantMessage("Once")]);
  try {
    // Admission outlasts the call: the reply is lost but the node admits.
    const node = loopbackNodeFor(state);
    const [admit, apply] = [node.prompt.bind(node), node.setModel.bind(node)];
    const slow = [
      spyOn(node, "prompt").mockImplementation(async input => { await Bun.sleep(30); return admit(input); }),
      spyOn(node, "setModel").mockImplementation(async input => { await Bun.sleep(30); return apply(input); }),
    ];
    // Sent over a link whose input and setModel bounds are 5ms.
    const link = await directLink(state, node);
    const hasty = (command: NodeCommand) => sessionRoute("s")!.send({ client: link, timeouts: { ...NODE_COMMAND_TIMEOUTS, input: 5, setModel: 5 } }, command);
    const id = enqueueInput("s", "prompt", text("Once"), "once")!;
    const command = getNodeCommand(id)!.command!;
    await deliverCommand(id, () => hasty(command));
    expect(getCommand(id)?.state).toBe("queued");
    for (let i = 0; i < 200 && inputs("once") === 0; i++) await Bun.sleep(5);
    // The replay is recognized by Pi's durable input ID and answered.
    await drainCommands(state);
    expect(getNodeCommand(id)).toBeNull();
    await untilSettled(1);
    expect(inputs("once")).toBe(1);

    const setModel: NodeCommand = { op: "session.setModel", sessionId: "s", provider: provider.provider.id, modelId: "other" };
    await expect(hasty(setModel)).rejects.toBeInstanceOf(DeliveryDeferred);
    for (let i = 0; i < 200 && lane().model.modelId !== "other"; i++) await Bun.sleep(5);
    for (const spy of slow) spy.mockRestore();
    // The replay applies the same absolute selection again.
    expect(await target.send(setModel)).toEqual({ ok: true, value: { modelSet: true } });
    expect(lane()).toMatchObject({ model: { provider: provider.provider.id, modelId: "other" } });
    expect(replies()).toBe(1);
  } finally { await dispose(); }
}, 15_000);

test("crash window: Pi admitted a prompt or steer but the server never learned it; the replay is recognized by Pi and admits nothing twice", async () => {
  const { state, untilSettled, inputs, replies, dispose } = await nodeSession("wire-crash", [fauxAssistantMessage("First"), fauxAssistantMessage("Second")]);
  try {
    const node = loopbackNodeFor(state);
    for (const [op, clientId, runs] of [["prompt", "crashed-prompt", 1], ["steer", "crashed-steer", 2]] as const) {
      const id = enqueueInput("s", op, text(clientId), clientId)!;
      const command = getNodeCommand(id)!.command!;
      // Admission the server never heard of: what a node crash right after Pi admission leaves.
      expect(await admitDirectly(node, command)).toEqual({ inputId: clientId });
      await untilSettled(runs);
      // The server never learned the outcome and replays the stored command over the wire.
      await drainCommands(state);
      expect(getNodeCommand(id)).toBeNull();
      await Bun.sleep(50);
      expect(inputs(clientId)).toBe(1);
      expect(replies()).toBe(runs);
    }
  } finally { await dispose(); }
}, 15_000);

test("a server restart interrupting deliveries requeues them: an input the node admitted converges on replay, one it never received and a model change are delivered once, in order", async () => {
  const { db, state, provider, untilSettled, inputs, replies, lane, dispose } = await nodeSession("restart-requeue", [
    fauxAssistantMessage("Admitted"), fauxAssistantMessage("Lost"), fauxAssistantMessage("Behind"),
  ]);
  /** The server stops while `id` is being delivered, and startup recovery runs in the next process. */
  const restartDuring = (id: string) => {
    db.query("UPDATE node_command_outbox SET state = 'dispatching' WHERE id = ?").run(id);
    expect(recoverInterruptedDispatches(db)).toBe(1);
    expect(getCommand(id)?.state).toBe("queued");
  };
  try {
    const node = loopbackNodeFor(state);
    const prompts = spyOn(node, "prompt");
    const modelChanges = spyOn(node, "setModel");

    // The node admitted the prompt; the server stopped before it learned so.
    const admitted = enqueueInput("s", "prompt", text("admitted"), "admitted")!;
    expect(await admitDirectly(node, getNodeCommand(admitted)!.command!)).toEqual({ inputId: "admitted" });
    await untilSettled(1);
    restartDuring(admitted);
    await drainCommands(state);
    expect(getCommand(admitted)).toBeNull();
    expect(inputs("admitted")).toBe(1);
    expect(replies()).toBe(1);

    // The node never received the prompt.
    const lost = enqueueInput("s", "prompt", text("lost"), "lost")!;
    restartDuring(lost);
    prompts.mockClear();
    await drainCommands(state);
    await untilSettled(2);
    expect(getCommand(lost)).toBeNull();
    expect(prompts.mock.calls.map(([input]) => input.clientId)).toEqual(["lost"]);
    expect([inputs("lost"), replies()]).toEqual([1, 2]);

    // An interrupted model change is applied once after the restart, still ahead of the prompt queued
    // behind it: that prompt runs on the new model.
    const change = enqueueSetModel("s", { provider: provider.provider.id, modelId: "other" });
    const behind = enqueueInput("s", "prompt", text("behind"), "behind")!;
    restartDuring(change);
    prompts.mockClear();
    await drainCommands(state);
    await untilSettled(3);
    expect([getCommand(change), getCommand(behind)]).toEqual([null, null]);
    expect(modelChanges).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveBeenCalledTimes(1);
    expect(modelChanges.mock.invocationCallOrder[0]).toBeLessThan(prompts.mock.invocationCallOrder[0]!);
    expect(lane()).toMatchObject({ model: { provider: provider.provider.id, modelId: "other" } });
    const last = db.query<{ message_json: string }, []>("SELECT message_json FROM session_messages WHERE session_id = 's' AND role = 'assistant' ORDER BY seq DESC").get()!;
    expect(JSON.parse(last.message_json).message).toMatchObject({ content: [{ type: "text", text: "Behind" }], model: "other" });
    expect([inputs("behind"), replies()]).toEqual([1, 3]);
  } finally { await dispose(); }
}, 15_000);

test("crash window while queued: a steer Pi holds in its queue behind a running run is recognized on replay", async () => {
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const { state, target, untilSettled, inputs, dispose } = await nodeSession("wire-queued", [
    () => new Promise(resolve => { started(); release = () => resolve(fauxAssistantMessage("Released")); }),
    fauxAssistantMessage("After steer"),
  ]);
  try {
    expect(await target.send({ op: "session.prompt", sessionId: "s", clientId: "block", content: text("Work"), sourceSessionId: null })).toMatchObject({ ok: true });
    await running;
    const id = enqueueInput("s", "steer", text("queued"), "queued")!;
    expect(await admitDirectly(loopbackNodeFor(state), getNodeCommand(id)!.command!)).toEqual({ inputId: "queued" });
    // The server's storage already proves the admission: Pi committed its pending steering entry before the reply.
    expect(storedInput("s", "queued")).toEqual({ queued: true });
    // Replayed while Pi still holds the steer in its queue (not yet a transcript entry).
    await drainCommands(state);
    expect(getNodeCommand(id)).toBeNull();
    release();
    await untilSettled(1);
    expect(inputs("queued")).toBe(1);
  } finally { await dispose(); }
}, 15_000);

