import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { silentLogger } from "../utils/logger.js";
import { createDaemonCommandRegistry } from "./daemon-command-registry.js";
import {
  SESSION_SHELL_PROFILE_METADATA_KEY,
  SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  SESSION_WORKFLOW_STATE_METADATA_KEY,
} from "./session.js";

function makeCommandRegistry(params?: {
  providerOverrides?: Array<Record<string, unknown>>;
  sessionOverrides?: Record<string, unknown>;
  memoryBackendOverrides?: Record<string, unknown>;
  gatewayLlmOverrides?: Record<string, unknown>;
  toolResponses?: Record<string, unknown>;
  toolCatalog?: Array<Record<string, unknown>>;
}) {
  const configDir = mkdtempSync(join(tmpdir(), "agenc-daemon-cmd-"));
  const configPath = join(configDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      llm: {
        provider: "grok",
        model: "grok-4.20-beta-0309-reasoning",
        reasoningEffort: "medium",
        statefulResponses: { enabled: true, store: true },
      },
      mcp: {
        servers: [{ name: "demo", enabled: true, trustTier: "trusted" }],
      },
    }),
    "utf8",
  );
  const session = {
    history: new Array(6).fill({}),
    metadata: {
      [SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY]: {
        previousResponseId: "resp-anchor-1",
      },
      [SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY]: true,
      ...(params?.sessionOverrides ?? {}),
    },
  } as any;

  const providers = (
    params?.providerOverrides ?? [
      {
        name: "grok",
        getCapabilities: () => ({
          provider: "grok",
          stateful: {
            assistantPhase: false,
            previousResponseId: true,
            encryptedReasoning: true,
            storedResponseRetrieval: true,
            storedResponseDeletion: true,
            opaqueCompaction: false,
            deterministicFallback: true,
          },
        }),
        retrieveStoredResponse: vi.fn(async () => ({
          id: "resp-anchor-1",
          provider: "grok",
          model: "grok-4.20-reasoning",
          status: "completed",
          content: "stored response content",
          toolCalls: [],
          encryptedReasoning: { requested: true, available: true },
          providerEvidence: {
            citations: ["https://x.ai"],
            serverSideToolUsage: [
              {
                category: "SERVER_SIDE_TOOL_WEB_SEARCH",
                toolType: "web_search",
                count: 1,
              },
            ],
          },
          raw: { id: "resp-anchor-1", output_text: "stored response content" },
        })),
        deleteStoredResponse: vi.fn(async () => ({
          id: "resp-anchor-1",
          provider: "grok",
          deleted: true,
          raw: { id: "resp-anchor-1", deleted: true },
        })),
      },
    ]
  ) as any[];

  const memoryBackend = {
    name: "sqlite",
    delete: vi.fn(async () => {}),
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
    ...(params?.memoryBackendOverrides ?? {}),
  } as any;
  const getSessionPolicyState = vi.fn(() => ({
    elevatedPatterns: [],
    deniedPatterns: [],
  }));
  const runNamedAgentTask = vi.fn(async ({ agentName }) => ({
    sessionId: `child-${agentName}-1`,
    output: `${agentName} complete`,
    success: true,
    status: "completed",
  }));
  const listSubAgentInfo = vi.fn(() => []);
  const webChatChannel = {
    loadSessionWorkspaceRoot: vi.fn(async () => "/tmp/project"),
    listContinuitySessionsForSession: vi.fn(async () => [
      {
        sessionId: "session-1",
        preview: "Ship shell",
        shellProfile: "coding",
        workflowStage: "implement",
        resumabilityState: "active",
        messageCount: 6,
        branch: "feature/coding-first-shell",
      },
    ]),
    inspectOwnedSession: vi.fn(async () => ({
      session: {
        sessionId: "session-1",
        shellProfile: "coding",
        workflowStage: "implement",
        resumabilityState: "active",
        messageCount: 6,
        pendingApprovalCount: 0,
        childSessionCount: 1,
        worktreeCount: 1,
        workspaceRoot: "/tmp/project",
        repoRoot: "/tmp/project",
        branch: "feature/coding-first-shell",
        head: "abc123",
        preview: "Ship shell",
      },
      recentHistory: [
        { sender: "user", content: "ship it" },
        { sender: "agent", content: "working on it" },
      ],
    })),
    loadOwnedSessionHistory: vi.fn(async () => [
      { sender: "user", content: "ship it" },
      { sender: "tool", toolName: "system.grep", content: "match" },
    ]),
    resumeOwnedSession: vi.fn(async () => ({
      sessionId: "session-2",
      messageCount: 4,
      workspaceRoot: "/tmp/project",
    })),
    forkOwnedSessionForRequester: vi.fn(async () => ({
      sourceSessionId: "session-1",
      targetSessionId: "session-fork-1",
      forkSource: "runtime_state",
      session: {
        sessionId: "session-fork-1",
        preview: "Ship shell",
      },
    })),
  };
  const updateSessionPolicyState = vi.fn((params) => ({
    elevatedPatterns:
      params.operation === "allow" && params.pattern ? [params.pattern] : [],
    deniedPatterns:
      params.operation === "deny" && params.pattern ? [params.pattern] : [],
  }));
  const defaultToolResponses: Record<string, unknown> = {
    "system.repoInventory": {
      repoRoot: "/tmp/project",
      branch: "feature/coding-first-shell",
      fileCount: 120,
      manifests: ["package.json"],
      topLevelDirectories: ["src", "docs", "tests"],
      languages: [
        { language: "TypeScript", count: 80 },
        { language: "Markdown", count: 10 },
      ],
    },
    "system.searchFiles": {
      matches: ["src/shell-profile.ts", "src/cli/index.ts"],
    },
    "system.grep": {
      matches: [
        {
          filePath: "src/shell-profile.ts",
          line: 12,
          column: 5,
          matchText: "shellProfile",
        },
      ],
      truncated: false,
    },
    "system.gitStatus": {
      repoRoot: "/tmp/project",
      branch: "feature/coding-first-shell",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      changed: [{ path: "src/cli/index.ts" }],
      summary: {
        staged: 1,
        unstaged: 2,
        untracked: 0,
        conflicted: 0,
      },
    },
    "system.gitBranchInfo": {
      repoRoot: "/tmp/project",
      branch: "feature/coding-first-shell",
      head: "abc123",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
    },
    "system.gitChangeSummary": {
      summary: {
        staged: 1,
        unstaged: 2,
        untracked: 0,
        renamed: 0,
        deleted: 0,
        conflicted: 0,
      },
    },
    "system.gitDiff": {
      diff: "diff --git a/src/cli/index.ts b/src/cli/index.ts\n+new line\n",
      truncated: false,
    },
    "system.gitShow": {
      output: "commit abc123\nAuthor: Test\n",
    },
    "system.gitWorktreeList": {
      worktrees: [
        {
          path: "/tmp/project",
          branch: "feature/coding-first-shell",
          head: "abc123",
          detached: false,
        },
      ],
    },
    "system.gitWorktreeCreate": {
      worktreePath: "/tmp/project-alt",
      branch: "alt",
      ref: null,
    },
    "system.gitWorktreeRemove": {
      worktreePath: "/tmp/project-alt",
      dirty: false,
    },
    "system.gitWorktreeStatus": {
      worktreePath: "/tmp/project-alt",
      branch: "alt",
      head: "def456",
      dirty: false,
      statusLines: [],
    },
    "task.list": {
      tasks: [{ id: "1", subject: "Ship shell", status: "in_progress" }],
    },
    "task.get": {
      task: {
        id: "1",
        subject: "Ship shell",
        status: "in_progress",
        description: "Do the work",
      },
    },
    "task.wait": {
      task: {
        id: "1",
        subject: "Ship shell",
        status: "completed",
        description: "Do the work",
      },
    },
    "task.output": {
      output: "done",
    },
  };
  const toolResponses = {
    ...defaultToolResponses,
    ...(params?.toolResponses ?? {}),
  };
  const baseToolHandler = vi.fn(async (name: string) =>
    JSON.stringify(toolResponses[name] ?? { error: `Unknown tool: ${name}` }),
  );
  const toolCatalog =
    params?.toolCatalog ?? [
      {
        name: "mcp.demo.lookup",
        description: "Lookup from MCP",
        inputSchema: {},
        metadata: { source: "mcp", family: "mcp", hiddenByDefault: false, mutating: false },
      },
      {
        name: "system.grep",
        description: "Search files",
        inputSchema: {},
        metadata: { source: "builtin", family: "coding", hiddenByDefault: false, mutating: false },
      },
    ];

  const registry = createDaemonCommandRegistry(
    {
      logger: silentLogger,
      configPath,
      gateway: {
        config: {
          llm: {
            provider: "grok",
            model: "grok-4.20-beta-0309-reasoning",
            sessionTokenBudget: 0,
            statefulResponses: {
              enabled: true,
              store: true,
            },
            includeEncryptedReasoning: true,
            ...(params?.gatewayLlmOverrides ?? {}),
          },
          mcp: {
            servers: [
              { name: "demo", enabled: true, trustTier: "trusted" },
            ],
          },
        },
      },
      yolo: false,
      resetWebSessionContext: vi.fn(async () => {}),
      getWebChatChannel: () => webChatChannel as any,
      getHostWorkspacePath: () => "/tmp/project",
      getChatExecutor: () =>
        ({
          getSessionTokenUsage: () => 25_136,
        }) as any,
      getResolvedContextWindowTokens: () => 2_000_000,
      getSystemPrompt: () => "# Agent\n# Repository Guidelines\n# Tool\n# Memory\n",
      getMemoryBackendName: () => "sqlite",
      getPolicyEngineState: () => undefined,
      isPolicyEngineEnabled: () => false,
      isGovernanceAuditLogEnabled: () => false,
      listSessionCredentialLeases: () => [],
      revokeSessionCredentials: vi.fn(async () => 0),
      resolvePolicyScopeForSession: ({ sessionId, runId, channel }) => ({
        sessionId,
        runId,
        channel: channel ?? "webchat",
      }),
      buildPolicySimulationPreview: vi.fn(async () => ({
        toolName: "system.readFile",
        sessionId: "session-1",
        policy: { allowed: true, mode: "normal", violations: [] },
        approval: { required: false, elevated: false, denied: false },
      })),
      getSessionPolicyState,
      updateSessionPolicyState,
      getSubAgentRuntimeConfig: () => null,
      getActiveDelegationAggressiveness: () => "balanced",
      resolveDelegationScoreThreshold: () => 0,
      getDelegationAggressivenessOverride: () => null,
      setDelegationAggressivenessOverride: () => {},
      configureDelegationRuntimeServices: () => {},
      getWebChatInboundHandler: () => null,
      getDesktopHandleBySession: () => undefined,
      getSessionModelInfo: () => ({
        provider: "grok",
        model: "grok-4.20-reasoning",
        usedFallback: false,
      }),
      handleConfigReload: vi.fn(async () => {}),
      getVoiceBridge: () => null,
      getDesktopManager: () => null,
      getDesktopBridges: () => new Map(),
      getPlaywrightBridges: () => new Map(),
      getContainerMCPBridges: () => new Map(),
      getGoalManager: () => null,
      startSlashInit: vi.fn(async () => ({
        filePath: "/tmp/project/AGENC.md",
        started: true,
      })),
      runNamedAgentTask,
      listSubAgentInfo,
    },
    {
      get: () => session,
    } as any,
    (value) => value,
    providers as any,
    memoryBackend,
    {
      size: 181,
      listCatalog: () => toolCatalog,
    } as any,
    [],
    [],
    {} as any,
    baseToolHandler as any,
    null,
    undefined,
    undefined,
  );

  return {
    registry,
    session,
    memoryBackend,
    providers,
    getSessionPolicyState,
    runNamedAgentTask,
    listSubAgentInfo,
    webChatChannel,
    updateSessionPolicyState,
    baseToolHandler,
  };
}

async function dispatchAndCollect(
  registry: ReturnType<typeof createDaemonCommandRegistry>,
  command: string,
): Promise<string[]> {
  const replies: string[] = [];
  const handled = await registry.dispatch(
    command,
    "session-1",
    "user-1",
    "webchat",
    async (content) => {
      replies.push(content);
    },
  );
  expect(handled).toBe(true);
  return replies;
}

describe("createDaemonCommandRegistry /context", () => {
  it("reports a finite local compaction window even when the hard session budget is unlimited", async () => {
    const { registry } = makeCommandRegistry();
    const replies = await dispatchAndCollect(registry, "/context");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Session Budget: unlimited");
    expect(replies[0]).toContain("Free: 574,864 tokens");
    expect(replies[0]).toContain(
      "Compaction: local enabled @ 600,000 tokens; provider disabled",
    );
  });
});

describe("createDaemonCommandRegistry /profile", () => {
  it("shows the current shell profile in /status", async () => {
    const { registry } = makeCommandRegistry({
      sessionOverrides: {
        [SESSION_SHELL_PROFILE_METADATA_KEY]: "coding",
        [SESSION_WORKFLOW_STATE_METADATA_KEY]: {
          stage: "plan",
          worktreeMode: "child_optional",
          enteredAt: 1,
          updatedAt: 1,
        },
      },
    });

    const replies = await dispatchAndCollect(registry, "/status");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Shell Profile: coding");
    expect(replies[0]).toContain("Workflow Stage: plan");
    expect(replies[0]).toContain("Worktree Mode: child optional");
  });

  it("lists the available shell profiles", async () => {
    const { registry } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, "/profile list");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Shell profile: general");
    expect(replies[0]).toContain("general (current)");
    expect(replies[0]).toContain("coding");
    expect(replies[0]).toContain("operator");
  });

  it("updates the shell profile and persists web session runtime state", async () => {
    const { registry, session, memoryBackend } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, "/profile coding");

    expect(session.metadata[SESSION_SHELL_PROFILE_METADATA_KEY]).toBe("coding");
    expect(memoryBackend.set).toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Shell profile set to coding.");
  });
});

describe("createDaemonCommandRegistry /policy", () => {
  it("shows session allow and deny overrides in policy status", async () => {
    const { registry, getSessionPolicyState } = makeCommandRegistry();
    getSessionPolicyState.mockReturnValue({
      elevatedPatterns: ["system.writeFile"],
      deniedPatterns: ["wallet.*"],
    });

    const replies = await dispatchAndCollect(registry, "/policy status");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Session allow patterns: system.writeFile");
    expect(replies[0]).toContain("Session deny patterns: wallet.*");
  });

  it("updates session allow overrides", async () => {
    const { registry, updateSessionPolicyState } = makeCommandRegistry();

    const replies = await dispatchAndCollect(
      registry,
      "/policy update allow system.writeFile",
    );

    expect(updateSessionPolicyState).toHaveBeenCalledWith({
      sessionId: "session-1",
      operation: "allow",
      pattern: "system.writeFile",
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Policy update: allow system.writeFile");
    expect(replies[0]).toContain("Session allow patterns: system.writeFile");
  });

  it("updates session deny and clear overrides", async () => {
    const { registry, updateSessionPolicyState } = makeCommandRegistry();
    updateSessionPolicyState
      .mockReturnValueOnce({
        elevatedPatterns: [],
        deniedPatterns: ["wallet.*"],
      })
      .mockReturnValueOnce({
        elevatedPatterns: [],
        deniedPatterns: [],
      });

    const denyReplies = await dispatchAndCollect(
      registry,
      "/policy update deny wallet.*",
    );
    const clearReplies = await dispatchAndCollect(
      registry,
      "/policy update clear wallet.*",
    );

    expect(updateSessionPolicyState).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      operation: "deny",
      pattern: "wallet.*",
    });
    expect(updateSessionPolicyState).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      operation: "clear",
      pattern: "wallet.*",
    });
    expect(denyReplies[0]).toContain("Policy update: deny wallet.*");
    expect(denyReplies[0]).toContain("Session deny patterns: wallet.*");
    expect(clearReplies[0]).toContain("Policy update: clear wallet.*");
    expect(clearReplies[0]).toContain("Session deny patterns: none");
  });

  it("resets session overrides", async () => {
    const { registry, updateSessionPolicyState } = makeCommandRegistry();
    updateSessionPolicyState.mockReturnValue({
      elevatedPatterns: [],
      deniedPatterns: [],
    });

    const replies = await dispatchAndCollect(registry, "/policy update reset");

    expect(updateSessionPolicyState).toHaveBeenCalledWith({
      sessionId: "session-1",
      operation: "reset",
      pattern: undefined,
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Policy update: reset");
    expect(replies[0]).toContain("Session allow patterns: none");
    expect(replies[0]).toContain("Session deny patterns: none");
  });
});

describe("createDaemonCommandRegistry /response", () => {
  it("shows the active stored-response status and encrypted reasoning setting", async () => {
    const { registry } = makeCommandRegistry();
    const replies = await dispatchAndCollect(registry, "/response status");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Retrieval supported: yes");
    expect(replies[0]).toContain("Deletion supported: yes");
    expect(replies[0]).toContain("Encrypted reasoning support: yes");
    expect(replies[0]).toContain("Current response anchor: resp-anchor-1");
  });

  it("retrieves the latest stored response via the active anchor", async () => {
    const { registry, providers } = makeCommandRegistry();
    const replies = await dispatchAndCollect(registry, "/response get latest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Stored response: resp-anchor-1");
    expect(replies[0]).toContain("stored response content");
    expect(providers[0].retrieveStoredResponse).toHaveBeenCalledWith(
      "resp-anchor-1",
    );
  });

  it("deletes the active stored response and clears the live continuation anchor", async () => {
    const { registry, session, memoryBackend, providers } = makeCommandRegistry();
    const replies = await dispatchAndCollect(registry, "/response delete latest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Stored response delete: confirmed");
    expect(replies[0]).toContain("Cleared active anchor: yes");
    expect(
      session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY],
    ).toBeUndefined();
    expect(
      session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY],
    ).toBeUndefined();
    expect(memoryBackend.delete).toHaveBeenCalled();
    expect(providers[0].deleteStoredResponse).toHaveBeenCalledWith(
      "resp-anchor-1",
    );
  });

  it("returns raw JSON for stored-response inspection when requested", async () => {
    const { registry } = makeCommandRegistry();
    const replies = await dispatchAndCollect(registry, "/response get latest --json");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("\"id\": \"resp-anchor-1\"");
    expect(replies[0]).toContain("\"output_text\": \"stored response content\"");
  });
});

describe("createDaemonCommandRegistry coding shell commands", () => {
  it("shows workflow stage in the shell session surface", async () => {
    const { registry } = makeCommandRegistry({
      sessionOverrides: {
        [SESSION_WORKFLOW_STATE_METADATA_KEY]: {
          stage: "review",
          worktreeMode: "child_optional",
          objective: "Review the shell workflow",
          enteredAt: 10,
          updatedAt: 20,
        },
      },
    });

    const replies = await dispatchAndCollect(registry, "/session");

    expect(replies[0]).toContain("Workflow stage: review");
    expect(replies[0]).toContain("Worktree mode: child optional");
    expect(replies[0]).toContain("Objective: Review the shell workflow");
  });

  it("lists resumable sessions via /session list", async () => {
    const { registry, webChatChannel } = makeCommandRegistry();

    const replies = await dispatchAndCollect(
      registry,
      '/session list {"activeOnly":true,"limit":5,"profile":"coding"}',
    );

    expect(replies[0]).toContain("Resumable sessions (1):");
    expect(replies[0]).toContain("session-1");
    expect(webChatChannel.listContinuitySessionsForSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        activeOnly: true,
        limit: 5,
        shellProfile: "coding",
      }),
    );
  });

  it("shows continuity detail via /session inspect", async () => {
    const { registry, webChatChannel } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, "/session inspect session-1");

    expect(replies[0]).toContain("Session detail:");
    expect(replies[0]).toContain("Branch: feature/coding-first-shell");
    expect(webChatChannel.inspectOwnedSession).toHaveBeenCalledWith(
      "session-1",
      "session-1",
    );
  });

  it("shows continuity history via /session history", async () => {
    const { registry, webChatChannel } = makeCommandRegistry();

    const replies = await dispatchAndCollect(
      registry,
      "/session history session-1 --include-tools",
    );

    expect(replies[0]).toContain("Session history (2):");
    expect(replies[0]).toContain("tool system.grep: match");
    expect(webChatChannel.loadOwnedSessionHistory).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        sessionId: "session-1",
        includeTools: true,
      }),
    );
  });

  it("resumes another owned session via /session resume", async () => {
    const { registry, webChatChannel } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, "/session resume session-2");

    expect(replies[0]).toContain("Resumed session session-2.");
    expect(webChatChannel.resumeOwnedSession).toHaveBeenCalledWith(
      "session-1",
      "session-2",
    );
  });

  it("forks a session via /session fork", async () => {
    const { registry, webChatChannel } = makeCommandRegistry();

    const replies = await dispatchAndCollect(
      registry,
      "/session fork session-1 --objective Investigate --profile research",
    );

    expect(replies[0]).toContain("Forked session session-fork-1 from session-1.");
    expect(replies[0]).toContain("Use /session resume <sessionId> to switch into the fork.");
    expect(webChatChannel.forkOwnedSessionForRequester).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        sessionId: "session-1",
        objective: "Investigate",
        shellProfile: "research",
      }),
    );
  });

  it("shows repo inventory for /files", async () => {
    const { registry, baseToolHandler } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, "/files");

    expect(replies[0]).toContain("Repo inventory:");
    expect(replies[0]).toContain("feature/coding-first-shell");
    expect(baseToolHandler).toHaveBeenCalledWith("system.repoInventory", {});
  });

  it("runs the structured grep command", async () => {
    const { registry, baseToolHandler } = makeCommandRegistry();

    const replies = await dispatchAndCollect(
      registry,
      '/grep {"pattern":"shellProfile"}',
    );

    expect(replies[0]).toContain("src/shell-profile.ts:12:5");
    expect(baseToolHandler).toHaveBeenCalledWith(
      "system.grep",
      expect.objectContaining({ pattern: "shellProfile" }),
    );
  });

  it("runs structured git status and worktree commands", async () => {
    const { registry, baseToolHandler } = makeCommandRegistry();

    const statusReplies = await dispatchAndCollect(registry, "/git status");
    const worktreeReplies = await dispatchAndCollect(
      registry,
      '/worktree {"action":"list"}',
    );

    expect(statusReplies[0]).toContain("Git status:");
    expect(statusReplies[0]).toContain("Changed files: 1");
    expect(worktreeReplies[0]).toContain("Worktrees (1):");
    expect(baseToolHandler).toHaveBeenCalledWith("system.gitStatus", {});
    expect(baseToolHandler).toHaveBeenCalledWith("system.gitWorktreeList", {
      action: "list",
      subcommand: "worktree",
    });
  });

  it("shows task state and MCP state", async () => {
    const { registry, baseToolHandler } = makeCommandRegistry();

    const taskReplies = await dispatchAndCollect(registry, "/tasks list");
    const mcpReplies = await dispatchAndCollect(registry, "/mcp list");

    expect(taskReplies[0]).toContain("Tasks (1):");
    expect(taskReplies[0]).toContain("Ship shell");
    expect(mcpReplies[0]).toContain("Configured servers: 1");
    expect(mcpReplies[0]).toContain("Connected MCP tools: 1");
    expect(baseToolHandler).toHaveBeenCalledWith("task.list", {
      __agencTaskListId: "session-1",
    });
  });

  it("shows and updates reasoning effort", async () => {
    const { registry } = makeCommandRegistry();

    const statusReplies = await dispatchAndCollect(registry, "/effort");
    const updateReplies = await dispatchAndCollect(registry, "/effort high");

    expect(statusReplies[0]).toContain("Reasoning effort:");
    expect(updateReplies[0]).toContain("Reasoning effort switched: medium → high");
  });

  it("enters plan mode with a coding-default child worktree posture", async () => {
    const { registry, session, memoryBackend } = makeCommandRegistry({
      sessionOverrides: {
        [SESSION_SHELL_PROFILE_METADATA_KEY]: "coding",
      },
    });

    const replies = await dispatchAndCollect(
      registry,
      '/plan {"subcommand":"enter","objective":"Ship Phase 4"}',
    );

    expect(replies[0]).toContain("Workflow stage set to plan.");
    expect(replies[0]).toContain("Worktree mode: child optional");
    expect(replies[0]).toContain("Objective: Ship Phase 4");
    expect(session.metadata[SESSION_WORKFLOW_STATE_METADATA_KEY]).toMatchObject({
      stage: "plan",
      worktreeMode: "child_optional",
      objective: "Ship Phase 4",
    });
    expect(memoryBackend.set).toHaveBeenCalled();
  });

  it("only allows /plan exit from plan mode", async () => {
    const { registry } = makeCommandRegistry({
      sessionOverrides: {
        [SESSION_WORKFLOW_STATE_METADATA_KEY]: {
          stage: "idle",
          worktreeMode: "off",
          enteredAt: 1,
          updatedAt: 1,
        },
      },
    });

    const replies = await dispatchAndCollect(registry, "/plan exit");

    expect(replies[0]).toContain(
      "Workflow exit is only available while the session is in plan mode.",
    );
  });

  it("delegates review through the restricted reviewer child without silently changing the stage", async () => {
    const { registry, runNamedAgentTask } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, '/review {"delegate":true}');

    expect(replies[0]).toContain("Review surface:");
    expect(replies[0]).toContain("Delegated reviewer session: child-review-1 [completed]");
    expect(replies[0]).toContain("review complete");
    expect(runNamedAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "review",
        parentSessionId: "session-1",
      }),
    );
  });

  it("delegates verification through the restricted verifier child", async () => {
    const { registry, runNamedAgentTask } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, '/verify {"delegate":true}');

    expect(replies[0]).toContain("Verification surface:");
    expect(replies[0]).toContain("Delegated verifier session: child-verify-1 [completed]");
    expect(replies[0]).toContain("verify complete");
    expect(runNamedAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "verify",
        parentSessionId: "session-1",
      }),
    );
  });
});
