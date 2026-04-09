import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createPiModelRegistry,
  hasPiExtensionProvider,
} from "../../pi/models-registry.js";
import { loadProviderSettingsForCwd, resolveClaudeAgentSdkCwd } from "../../pi/vendor/claude-agent-sdk-pi.js";

describe("pi extensions", () => {
  test("loads the claude-agent-sdk provider into Reins' pi model registry", async () => {
    const pi = await createPiModelRegistry({
      cwd: "/tmp/reins-pi-runtime",
    });

    expect(pi.extensionErrors).toEqual([]);
    expect(hasPiExtensionProvider(pi.providerRegistrations, "claude-agent-sdk")).toBe(true);
    expect(pi.modelRegistry.find("claude-agent-sdk", "claude-opus-4-5")).toBeDefined();
  });

  test("vendored claude-agent-sdk helpers read supported provider settings from cwd", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "reins-claude-agent-sdk-settings-"));

    try {
      const piDir = join(projectDir, ".pi");
      mkdirSync(piDir, { recursive: true });
      writeFileSync(
        join(piDir, "settings.json"),
        JSON.stringify({
          claudeAgentSdkProvider: {
            appendSystemPrompt: false,
            settingSources: ["project", "local"],
            strictMcpConfig: false,
          },
        }),
      );

      expect(loadProviderSettingsForCwd(projectDir)).toEqual({
        settingSources: ["project", "local"],
        strictMcpConfig: false,
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("vendored claude-agent-sdk helpers default to no Claude setting sources", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "reins-claude-agent-sdk-settings-"));

    try {
      expect(loadProviderSettingsForCwd(projectDir)).toEqual({});
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("vendored claude-agent-sdk stream cwd resolver falls back to process.cwd() when no explicit cwd is provided", () => {
    const explicitOptions: Parameters<typeof resolveClaudeAgentSdkCwd>[0] & { cwd: string } = {
      cwd: "/tmp/explicit-cwd",
    };
    const explicit = resolveClaudeAgentSdkCwd(explicitOptions);
    expect(explicit).toBe("/tmp/explicit-cwd");

    const fallback = resolveClaudeAgentSdkCwd(undefined);
    expect(fallback).toBe(process.cwd());
  });

});
