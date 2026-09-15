import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";

type Json = Record<string, unknown>;
type SourceRow = { id:number; session_id:string; seq:number; parent_id:number|null; role:string; message_json:string; created_at:string };
type OutputRow = SourceRow & { harness_id:string|null };

function option(name: string, required = true): string | undefined {
  const index = process.argv.indexOf(name); const value = index < 0 ? undefined : process.argv[index + 1];
  if (required && (!value || value.startsWith("--"))) throw new Error(`Required option: ${name}`);
  return value;
}
function json(value: string): Json { return JSON.parse(value); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function normalizedSource(message: Json): Json {
  if (message.role === "compactionSummary") return { role: "compactionSummary", summary: message.summary, timestamp: message.timestamp, tokensBefore: message.tokensBefore ?? 0 };
  if (message.role === "user") return { role: "user", content: message.content, timestamp: message.timestamp, ...(typeof message.clientMessageId === "string" ? { clientMessageId: message.clientMessageId } : {}) };
  const { logicalId: _logicalId, metadata: _metadata, ...native } = message; return native;
}
function normalizedOutput(envelope: Json): Json {
  if (envelope.type === "compaction") return { role: "compactionSummary", summary: envelope.summary, timestamp: envelope.timestamp, tokensBefore: envelope.tokensBefore };
  if (typeof envelope.message !== "object" || envelope.message === null || Array.isArray(envelope.message)) throw new Error("Invalid message envelope");
  const message: Json = envelope.message;
  if (message.role === "reinsInput") return { role: "user", content: message.content, timestamp: message.timestamp,
    ...(typeof message.reinsId === "string" ? { clientMessageId: message.reinsId } : {}) };
  const { logicalId: _logicalId, metadata: _metadata, ...native } = message; return native;
}
function addHash(hash: ReturnType<typeof createHash>, value: unknown): void { hash.update(JSON.stringify(value)); hash.update("\n"); }

export async function validate(sourcePath: string, outputPath: string) {
  if (realpathSync(sourcePath) === realpathSync(outputPath)) throw new Error("Source and output must differ");
  const source = new Database(sourcePath, { readonly: true }); const output = new Database(outputPath, { readonly: true });
  try {
    const expectedTables: Record<string,string[]>={pi_values:["session_id","namespace","key","seq","value_json"],pi_lists:["session_id","namespace","key","seq","value_json"],pi_usage:["session_id","id","seq","entry_id","adjustment","usage_json","details_json"]};
    for(const [table,expected] of Object.entries(expectedTables)){const columns=output.query<{name:string},[]>(`PRAGMA table_info(${table})`).all().map((row)=>row.name);if(!same(columns,expected))throw new Error(`Invalid canonical schema for ${table}`);}
    const expectedHash = createHash("sha256"); const actualHash = createHash("sha256");
    const sourceRows = source.query<SourceRow, []>("SELECT id,session_id,seq,parent_id,role,message_json,created_at FROM session_messages ORDER BY session_id,seq,id").all();
    const outputRows = output.query<OutputRow, []>("SELECT id,session_id,seq,parent_id,role,message_json,created_at,harness_id FROM session_messages ORDER BY session_id,seq,id").all();
    if (sourceRows.length !== outputRows.length) throw new Error("Message row count differs");
    let repairs = 0; const repairedSessions = new Set<string>(); const sourceBySession = new Map<string, Json[]>(); const outputBySession = new Map<string, OutputRow[]>();
    let previousSession = ""; let previousId: number | null = null;
    for (let index=0; index<sourceRows.length; index++) {
      const before=sourceRows[index]!; const after=outputRows[index]!; const sourceMessage=json(before.message_json); const envelope=json(after.message_json);
      if (before.session_id !== previousSession) { previousSession=before.session_id; previousId=null; }
      if (before.parent_id !== null && before.parent_id !== previousId) throw new Error(`Source has non-linear parent at row ${before.id}`);
      const expectedParent=previousId; previousId=before.id;
      if (before.parent_id !== expectedParent) { repairs++; repairedSessions.add(before.session_id); }
      if (after.id!==before.id || after.session_id!==before.session_id || after.seq!==before.seq || after.created_at!==before.created_at || after.parent_id!==expectedParent || !after.harness_id) throw new Error(`Structural mismatch at row ${before.id}`);
      const expectedRole=before.role==="user"?"reinsInput":before.role==="compactionSummary"?"compaction":before.role;
      if (after.role!==expectedRole) throw new Error(`Physical role mismatch at row ${before.id}`);
      const normalizedBefore=normalizedSource(sourceMessage); const normalizedAfter=normalizedOutput(envelope);
      if (before.role==="user" && sourceMessage.clientMessageId === undefined) delete normalizedAfter.clientMessageId;
      if (!same(normalizedBefore,normalizedAfter)) throw new Error(`Archive projection mismatch at row ${before.id}`);
      addHash(expectedHash,[before.id,normalizedBefore]); addHash(actualHash,[after.id,normalizedAfter]);
      const sourceMessages=sourceBySession.get(before.session_id)??[];sourceMessages.push(normalizedSource(sourceMessage));sourceBySession.set(before.session_id,sourceMessages);
      const rows=outputBySession.get(after.session_id)??[];rows.push(after);outputBySession.set(after.session_id,rows);
    }
    const activeExpected=createHash("sha256"); const activeActual=createHash("sha256"); let activeEntries=0;
    const sessions=source.query<{id:string},[]>("SELECT id FROM sessions ORDER BY id").all();
    for (const {id} of sessions) {
      const sourceMessages=sourceBySession.get(id)??[];
      const boundary=sourceMessages.findLastIndex((message)=>message.role==="compactionSummary"); const expected=sourceMessages.slice(boundary<0?0:boundary);
      const rows=outputBySession.get(id)??[];
      const values=output.query<{namespace:string;seq:number;value_json:string},[string]>("SELECT namespace,seq,value_json FROM pi_values WHERE session_id=? AND key='main' ORDER BY namespace").all(id);
      if (values.length!==3 || values.map((row)=>row.namespace).join(",")!=="pi.branch.tip,pi.lane.config,pi.lane.state") throw new Error(`Incomplete main lane for session ${id}`);
      const tip: unknown=JSON.parse(values[0]!.value_json); const config: Json=JSON.parse(values[1]!.value_json); const state: Json=JSON.parse(values[2]!.value_json);
      if (!config.model || typeof config.thinkingLevel!=="string" || !Array.isArray(config.activeToolNames) || !same(state,{currentOperationId:null,lastOperationId:null,inbox:[]})) throw new Error(`Invalid main lane values for session ${id}`);
      if (rows.length===0 ? tip!==null : tip!==rows.at(-1)!.harness_id) throw new Error(`Main tip is not the final entry for session ${id}`);
      const byHarness=new Map(rows.map((row)=>[row.harness_id,row])); const branch: OutputRow[]=[]; let cursor=tip; const seen=new Set<unknown>();
      while(typeof cursor==="string") { if(seen.has(cursor))throw new Error(`Cyclic main ancestry for session ${id}`);seen.add(cursor);const row=byHarness.get(cursor);if(!row)throw new Error(`Main tip ancestry leaves session ${id}`);branch.push(row);const envelope=json(row.message_json);if(envelope.type==="compaction")break;cursor=row.parent_id===null?null:rows.find((candidate)=>candidate.id===row.parent_id)?.harness_id; }
      const actual=branch.toReversed().map((row)=>normalizedOutput(json(row.message_json)));
      for (let i=0;i<expected.length;i++) if (expected[i]!.role==="user" && !expected[i]!.clientMessageId) delete actual[i]!.clientMessageId;
      if (!same(expected,actual)) throw new Error(`Active context differs for session ${id}`);
      const maxWriteSeq=Math.max(0,...rows.map((row)=>row.seq),...values.map((row)=>row.seq));
      const nextSeq=output.query<{harness_next_seq:number},[string]>("SELECT harness_next_seq FROM sessions WHERE id=?").get(id)!.harness_next_seq;
      if(nextSeq<=maxWriteSeq)throw new Error(`Invalid harness_next_seq for session ${id}`);
      addHash(activeExpected,[id,expected]);addHash(activeActual,[id,actual]);activeEntries+=actual.length;
    }
    const attachmentHash=(db:Database)=>{const h=createHash("sha256");for(const row of db.query<Record<string,unknown>,[]>("SELECT * FROM session_attachments ORDER BY id").all()){const copy={...row};if(copy.data instanceof Uint8Array)copy.data=createHash("sha256").update(copy.data).digest("hex");addHash(h,copy);}return h.digest("hex");};
    const laneCounts=Object.fromEntries(output.query<{namespace:string,count:number},[]>("SELECT namespace,COUNT(*) count FROM pi_values GROUP BY namespace").all().map((r)=>[r.namespace,r.count]));
    const report={messages:sourceRows.length,archiveExpectedHash:expectedHash.digest("hex"),archiveActualHash:actualHash.digest("hex"),ancestryRepair:{changedLinks:repairs,affectedSessions:repairedSessions.size},sessions:sessions.length,activeEntries,activeExpectedHash:activeExpected.digest("hex"),activeActualHash:activeActual.digest("hex"),attachmentSourceHash:attachmentHash(source),attachmentOutputHash:attachmentHash(output),laneCounts,quickCheck:output.query<{quick_check:string},[]>("PRAGMA quick_check").get()!.quick_check,foreignKeyRows:output.query("PRAGMA foreign_key_check").all().length};
    if (report.archiveExpectedHash!==report.archiveActualHash || report.activeExpectedHash!==report.activeActualHash || report.attachmentSourceHash!==report.attachmentOutputHash) throw new Error("Validation hashes differ");
    return report;
  } finally { source.close(); output.close(); }
}

if (import.meta.main) {
  const source=option("--source")!;const output=option("--output")!;const reportPath=option("--report",false);
  const report=await validate(source,output); if(reportPath){if(existsSync(reportPath))throw new Error(`Report already exists: ${reportPath}`);await writeFile(reportPath,`${JSON.stringify(report,null,2)}\n`,{flag:"wx"});}console.log(JSON.stringify(report,null,2));
}
