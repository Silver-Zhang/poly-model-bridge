"use strict";
const vscode = require("vscode");
const { PolyBridgeProvider, VENDOR, getProviders } = require("./provider");

async function pickProvider() {
  const providers = getProviders();
  if (providers.length === 0) {
    const pick = await vscode.window.showInformationMessage(
      "Poly Model Bridge: configure providers in settings first.",
      "Open Settings"
    );
    if (pick === "Open Settings") {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "polyBridge.providers"
      );
    }
    return undefined;
  }
  if (providers.length === 1) {
    return providers[0].name;
  }
  const pick = await vscode.window.showQuickPick(
    providers.map((p) => ({ label: p.name, description: p.baseUrl })),
    { title: "Select provider" }
  );
  return pick && pick.label;
}

function activate(context) {
  const provider = new PolyBridgeProvider(context.secrets);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("polyBridge.setApiKey", async () => {
      const name = await pickProvider();
      if (name) {
        await provider.promptForApiKey(name);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("polyBridge.manage", async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: "$(key) Set / update API key", action: "key" },
          { label: "$(gear) Configure providers & models", action: "settings" },
        ],
        { title: "Poly Model Bridge" }
      );
      if (pick && pick.action === "key") {
        const name = await pickProvider();
        if (name) {
          await provider.promptForApiKey(name);
        }
      } else if (pick && pick.action === "settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "polyBridge.providers"
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("polyBridge")) {
        provider.refresh();
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
