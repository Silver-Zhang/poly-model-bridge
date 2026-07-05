"use strict";
const vscode = require("vscode");
const { PolyBridgeProvider, VENDOR, getProviders } = require("./provider");
const { manageHub, addProviderWizard, quickSettings, fmtTokens } = require("./ui");

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

function activate(context) {
  const provider = new PolyBridgeProvider(context.secrets);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider)
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
    if (providers.length === 0) {
      status.hide();
      return;
    }
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
      await manageHub(provider);
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
