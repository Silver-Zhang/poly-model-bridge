"use strict";
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const {
  PolyBridgeProvider,
  VENDOR,
  getProviders,
  enumerateModels,
} = require("./provider");
const { addProviderWizard, quickSettings, fmtTokens } = require("./ui");
const { ManagerPanel } = require("./manager");
const { SidebarProvider } = require("./sidebar");
const { planCliEnv, formatEnvSnippet } = require("./cli");

const CLI_INSTALL_COMMAND = "npm install -g @github/copilot";
const CLI_DOCS_URL =
  "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models";

async function pickProvider() {
  const providers = getProviders();
  if (providers.length === 0) {
    const pick = await vscode.window.showInformationMessage(
      "Poly Model Bridge: 还没有配置中转站。",
      "添加中转站"
    );
    return pick === "添加中转站" ? "__add__" : undefined;
  }
  if (providers.length === 1) {
    return providers[0].name;
  }
  const pick = await vscode.window.showQuickPick(
    providers.map((p) => ({ label: p.name, description: p.baseUrl })),
    { title: "选择中转站" }
  );
  return pick && pick.label;
}

/**
 * Copy the string other VS Code features use to address a PolyBridge model.
 * The two forms are not interchangeable: custom agents and instructions match
 * on the qualified name, while `chat.utilityModel` parses `vendor/id`.
 */
async function copyModelReference() {
  const entries = enumerateModels();
  if (entries.length === 0) {
    vscode.window.showInformationMessage(
      "Poly Model Bridge: 还没有配置模型，请先在管理界面添加。"
    );
    return;
  }
  const model = await vscode.window.showQuickPick(
    entries.map((entry) => ({
      label: entry.info.name,
      description: entry.provider.name,
      entry,
    })),
    { title: "复制模型引用名：选择模型", ignoreFocusOut: true }
  );
  if (!model) {
    return;
  }
  const form = await vscode.window.showQuickPick(
    [
      {
        label: model.entry.qualifiedName,
        detail: "用于自定义 Agent 的 model: 字段、项目指令、runSubagent 的 model 参数",
        value: model.entry.qualifiedName,
      },
      {
        label: model.entry.utilityRef,
        detail: "用于 chat.utilityModel / chat.utilitySmallModel",
        value: model.entry.utilityRef,
      },
    ],
    { title: "复制哪种形式？", ignoreFocusOut: true }
  );
  if (!form) {
    return;
  }
  await vscode.env.clipboard.writeText(form.value);
  vscode.window.showInformationMessage("已复制：" + form.value);
}

/**
 * Shared model picker for the Copilot CLI commands. `pickerId` short-circuits
 * it: the manager panel already has a model chosen, so it passes that through
 * rather than asking twice.
 */
async function pickModelEntry(title, pickerId) {
  const entries = enumerateModels();
  if (entries.length === 0) {
    vscode.window.showInformationMessage(
      "Poly Model Bridge: 还没有配置模型，请先在管理界面添加。"
    );
    return undefined;
  }
  if (pickerId) {
    const chosen = entries.find((entry) => entry.pickerId === pickerId);
    if (!chosen) {
      vscode.window.showWarningMessage(
        "Poly Model Bridge: 选中的模型已不存在，请重新选择。"
      );
    }
    return chosen;
  }
  const pick = await vscode.window.showQuickPick(
    entries.map((entry) => ({
      label: entry.info.name,
      description: entry.provider.name,
      detail: entry.info.tooltip,
      entry,
    })),
    { title, ignoreFocusOut: true, matchOnDetail: true }
  );
  return pick && pick.entry;
}

/**
 * Locate the `copilot` executable the way a shell would. Used only to warn
 * before spawning a terminal — the terminal resolves the command itself, so a
 * miss here is not fatal.
 */
function findCopilotOnPath() {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, "copilot" + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // unreadable PATH entry
      }
    }
  }
  return undefined;
}

/** Ask before launching into a shell where `copilot` does not exist. */
async function confirmCliPresent() {
  if (findCopilotOnPath()) {
    return true;
  }
  const pick = await vscode.window.showWarningMessage(
    "没有在 PATH 中找到 copilot 命令，Copilot CLI 可能尚未安装。",
    "复制安装命令",
    "查看文档",
    "仍然启动"
  );
  if (pick === "复制安装命令") {
    await vscode.env.clipboard.writeText(CLI_INSTALL_COMMAND);
    vscode.window.showInformationMessage("已复制：" + CLI_INSTALL_COMMAND);
    return false;
  }
  if (pick === "查看文档") {
    vscode.env.openExternal(vscode.Uri.parse(CLI_DOCS_URL));
    return false;
  }
  return pick === "仍然启动";
}

/** Resolve the API key for a provider, prompting once if it is missing. */
async function apiKeyFor(provider, entryProvider) {
  if (entryProvider.requiresApiKey === false) {
    return "";
  }
  let key = await provider.getApiKey(entryProvider.name);
  if (!key) {
    key = await provider.promptForApiKey(entryProvider.name);
  }
  return key || "";
}

/** Record what a CLI session was launched with, minus the credentials. */
function logCliPlan(output, entry, env, warnings) {
  output.appendLine(
    `[cli] ${entry.provider.name}/${entry.model.id} -> ${env.COPILOT_PROVIDER_BASE_URL} ` +
      `(type=${env.COPILOT_PROVIDER_TYPE}${
        env.COPILOT_PROVIDER_WIRE_API ? ", wireApi=" + env.COPILOT_PROVIDER_WIRE_API : ""
      })`
  );
  for (const warning of warnings) {
    output.appendLine("[cli] 注意：" + warning);
  }
}

/**
 * Build the environment for a CLI session. Returns undefined when the user
 * backed out at the model picker or the key prompt.
 */
async function prepareCliSession(provider, title, pickerId) {
  const entry = await pickModelEntry(title, pickerId);
  if (!entry) {
    return undefined;
  }
  const apiKey = await apiKeyFor(provider, entry.provider);
  if (!apiKey && entry.provider.requiresApiKey !== false) {
    vscode.window.showWarningMessage(
      `Poly Model Bridge: 没有 "${entry.provider.name}" 的 API key，已取消。`
    );
    return undefined;
  }
  return { entry, ...planCliEnv(entry, apiKey) };
}

async function launchCopilotCli(provider, output, pickerId) {
  const session = await prepareCliSession(provider, "Copilot CLI：选择模型", pickerId);
  if (!session) {
    return;
  }
  if (!(await confirmCliPresent())) {
    return;
  }
  const { entry, env, warnings } = session;
  logCliPlan(output, entry, env, warnings);
  const terminal = vscode.window.createTerminal({
    name: "Copilot CLI · " + entry.info.name,
    env,
  });
  terminal.show();
  terminal.sendText("copilot");
  vscode.window
    .showInformationMessage(
      `已启动 Copilot CLI：${entry.info.name}（${entry.provider.name}）`,
      "查看注意事项"
    )
    .then((pick) => {
      if (pick === "查看注意事项") {
        output.show(true);
      }
    });
}

async function copyCopilotCliEnv(provider, output, pickerId, presetShell) {
  const session = await prepareCliSession(
    provider,
    "复制 Copilot CLI 环境变量：选择模型",
    pickerId
  );
  if (!session) {
    return;
  }
  let shell = presetShell;
  if (!shell) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "PowerShell", detail: "$env:NAME = '值'", value: "pwsh" },
        { label: "bash / zsh", detail: "export NAME='值'", value: "bash" },
        { label: "cmd", detail: 'set "NAME=值"', value: "cmd" },
      ],
      { title: "用哪种 shell？", ignoreFocusOut: true }
    );
    if (!pick) {
      return;
    }
    shell = pick.value;
  }
  const { entry, env, warnings } = session;
  logCliPlan(output, entry, env, warnings);
  await vscode.env.clipboard.writeText(
    formatEnvSnippet(env, shell, { maskKey: true })
  );
  vscode.window.showInformationMessage(
    "已复制环境变量。出于安全考虑 API key 用占位符代替，请自行替换。"
  );
}

function activate(context) {
  const output = vscode.window.createOutputChannel("PolyBridge");
  context.subscriptions.push(output);
  const provider = new PolyBridgeProvider(context.secrets, output);
  const sidebar = new SidebarProvider(context);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    vscode.window.registerWebviewViewProvider("polyBridge.managerView", sidebar)
  );

  // status bar: effort / context dial for the most recently used model
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    90
  );
  status.command = "polyBridge.quickSettings";
  context.subscriptions.push(status);

  function updateStatus() {
    const providers = getProviders();
    sidebar.refresh();
    if (providers.length === 0) {
      status.text = "$(plug) PolyBridge";
      status.tooltip = "Poly Model Bridge：点击打开管理界面";
      status.command = "polyBridge.manage";
      status.show();
      return;
    }
    status.command = "polyBridge.quickSettings";
    let text = "$(plug) PolyBridge";
    let tooltip = "Poly Model Bridge：点击调整思考工作量 / 上下文长度";
    const last = provider.lastUsed;
    if (last) {
      const p = providers.find((x) => x.name === last.providerName);
      const m = p && p.models.find((x) => x.id === last.modelId);
      if (m) {
        text =
          "$(plug) " + (m.name || m.id) +
          " · " + (m.effort || (m.efforts ? m.efforts.join("/") : "high")) +
          " · " + fmtTokens(m.maxInputTokens || 200000);
        tooltip = `${m.name || m.id}（${p.name}）\n点击调整思考工作量 / 上下文长度`;
      }
    }
    status.text = text;
    status.tooltip = tooltip;
    status.show();
  }
  updateStatus();
  context.subscriptions.push(provider.onDidUseModel(updateStatus));

  context.subscriptions.push(
    vscode.commands.registerCommand("polyBridge.quickSettings", async () => {
      await quickSettings(provider);
      updateStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("polyBridge.setApiKey", async () => {
      const name = await pickProvider();
      if (name === "__add__") {
        await addProviderWizard(provider);
      } else if (name) {
        await provider.promptForApiKey(name);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("polyBridge.addProvider", async () => {
      await addProviderWizard(provider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("polyBridge.manage", async () => {
      ManagerPanel.show(context, provider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("polyBridge.copyModelReference", async () => {
      await copyModelReference();
    })
  );

  context.subscriptions.push(
    // Both take an optional picker id (and shell) so the manager panel, which
    // already has a model selected, can reuse them without a second prompt.
    vscode.commands.registerCommand(
      "polyBridge.launchCopilotCli",
      async (pickerId) => {
        await launchCopilotCli(provider, output, pickerId);
      }
    ),
    vscode.commands.registerCommand(
      "polyBridge.copyCopilotCliEnv",
      async (pickerId, shell) => {
        await copyCopilotCliEnv(provider, output, pickerId, shell);
      }
    )
  );

  // Same thing from the terminal's `+` dropdown. A profile cannot send input,
  // so `copilot` has to be the shell itself; without it on PATH the profile
  // falls back to a normal shell that already has the variables set.
  if (vscode.window.registerTerminalProfileProvider) {
    context.subscriptions.push(
      vscode.window.registerTerminalProfileProvider("polyBridge.copilotCli", {
        provideTerminalProfile: async () => {
          const session = await prepareCliSession(
            provider,
            "Copilot CLI：选择模型"
          );
          if (!session) {
            return undefined;
          }
          logCliPlan(output, session.entry, session.env, session.warnings);
          const copilot = findCopilotOnPath();
          if (!copilot) {
            vscode.window.showWarningMessage(
              "没有在 PATH 中找到 copilot 命令。终端已设好环境变量，安装后（" +
                CLI_INSTALL_COMMAND +
                "）直接运行 copilot 即可。"
            );
          }
          return new vscode.TerminalProfile({
            name: "Copilot CLI · " + session.entry.info.name,
            env: session.env,
            ...(copilot ? { shellPath: copilot } : {}),
          });
        },
      })
    );
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("polyBridge")) {
        provider.refresh();
        updateStatus();
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
