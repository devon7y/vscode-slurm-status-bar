import * as vscode from 'vscode';
import {
    FAIRSHARE_HISTORY_PATH,
    OPEN_FAIRSHARE_HISTORY_COMMAND,
    SHOW_FAIRSHARE_GRAPH_COMMAND,
    SHOW_FULL_STATUS_COMMAND,
} from './constants';
import {
    readHistoryRows,
    readJobHistory,
    readJobSnapshots,
    readNodeHistory,
} from './dataReaders';
import {
    createStatusBar,
    getCurrentStatusText,
    startMonitoring,
    stopMonitoring,
} from './statusBar';
import { buildFairshareGraphHtml } from './dashboard/html';

let fairshareGraphPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
    console.log('HPC Usage Dashboard extension is now active!');

    createStatusBar(context);

    context.subscriptions.push(
        vscode.commands.registerCommand(SHOW_FULL_STATUS_COMMAND, showFullStatus),
        vscode.commands.registerCommand(SHOW_FAIRSHARE_GRAPH_COMMAND, () => showDashboard(context)),
        vscode.commands.registerCommand(OPEN_FAIRSHARE_HISTORY_COMMAND, openFairshareHistory),
    );

    startMonitoring();
}

export function deactivate(): void {
    stopMonitoring();
}

async function showFullStatus(): Promise<void> {
    const statusText = getCurrentStatusText();
    if (!statusText) {
        return;
    }
    const document = await vscode.workspace.openTextDocument({
        content: `${statusText}\n`,
        language: 'text',
    });
    await vscode.window.showTextDocument(document, {
        preview: true,
        preserveFocus: false,
    });
}

async function showDashboard(_context: vscode.ExtensionContext): Promise<void> {
    const [historyRows, jobHistory, jobSnapshots, nodeHistory] = await Promise.all([
        readHistoryRows(),
        readJobHistory(),
        readJobSnapshots(),
        readNodeHistory(),
    ]);

    const html = buildFairshareGraphHtml(historyRows, jobHistory, jobSnapshots, nodeHistory);

    if (fairshareGraphPanel) {
        fairshareGraphPanel.webview.html = html;
        fairshareGraphPanel.reveal(vscode.ViewColumn.Active, false);
        return;
    }

    fairshareGraphPanel = vscode.window.createWebviewPanel(
        'slurmStatusBarFairshareGraph',
        'HPC Usage Dashboard',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            enableFindWidget: true,
        },
    );
    fairshareGraphPanel.onDidDispose(() => {
        fairshareGraphPanel = undefined;
    });
    fairshareGraphPanel.webview.html = html;
}

async function openFairshareHistory(): Promise<void> {
    try {
        const document = await vscode.workspace.openTextDocument(
            vscode.Uri.file(FAIRSHARE_HISTORY_PATH),
        );
        await vscode.window.showTextDocument(document, {
            preview: true,
            preserveFocus: false,
        });
    } catch (error) {
        const message = error instanceof Error
            ? error.message
            : 'Fairshare history file is not available yet.';
        void vscode.window.showInformationMessage(message);
    }
}
