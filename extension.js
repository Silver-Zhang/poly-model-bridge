"use strict";
const vscode = require("vscode");
const {
  PolyBridgeProvider,
  VENDOR,
  getProviders,
  enumerateModels,
} = require("./provider");
const { addProviderWizard, quickSettings, fmtTokens } = require("./ui");
const { ManagerPanel } = require("./manager");
const { SidebarProvider } = require("./sidebar");

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
