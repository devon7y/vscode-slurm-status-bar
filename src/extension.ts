import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let statusBarItem: vscode.StatusBarItem;
let fileWatcher: fs.FSWatcher | undefined;
let updateInterval: NodeJS.Timer | undefined;

const FILE_PATH = path.join(os.homedir(), '.slurm_status_bar.txt');
const UPDATE_INTERVAL_MS = 1000; // 1 second

export function activate(context: vscode.ExtensionContext) {
    console.log('Slurm Status Bar extension is now active!');

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        0  // Priority 0 = default position
    );
    statusBarItem.tooltip = 'Slurm Job Status';
    context.subscriptions.push(statusBarItem);

    // Set up file watcher
    setupFileWatcher();

    // Set up periodic updates
    setupPeriodicUpdates();

    // Initial update
    updateStatusBar();
}

function setupFileWatcher(): void {
    try {
        // Watch the directory since the file might not exist yet
        const fileDir = path.dirname(FILE_PATH);
        const fileName = path.basename(FILE_PATH);

        // Try to watch the file directly first
        if (fs.existsSync(FILE_PATH)) {
            fileWatcher = fs.watch(FILE_PATH, (eventType, filename) => {
                if (eventType === 'change') {
                    console.log('File changed, updating status bar');
                    updateStatusBar();
                }
            });
            console.log(`Watching file: ${FILE_PATH}`);
        } else {
            // File doesn't exist yet, watch the directory
            console.log(`File doesn't exist yet, watching directory: ${fileDir}`);
            fileWatcher = fs.watch(fileDir, (eventType, filename) => {
                if (filename === fileName && eventType === 'rename') {
                    // File was created, switch to watching the file
                    console.log('File created, switching to file watch');
                    if (fileWatcher) {
                        fileWatcher.close();
                    }
                    setupFileWatcher();
                    updateStatusBar();
                } else if (filename === fileName && eventType === 'change') {
                    updateStatusBar();
                }
            });
        }
    } catch (error) {
        console.error('Error setting up file watcher:', error);
        statusBarItem.text = '$(warning) Cannot watch file';
        statusBarItem.show();
    }
}

function setupPeriodicUpdates(): void {
    updateInterval = setInterval(() => {
        updateStatusBar();
    }, UPDATE_INTERVAL_MS);
    console.log(`Set up periodic updates every ${UPDATE_INTERVAL_MS}ms`);
}

function updateStatusBar(): void {
    fs.readFile(FILE_PATH, 'utf8', (error, data) => {
        if (error) {
            if (error.code === 'ENOENT') {
                statusBarItem.text = '$(circle-slash) No Slurm status';
                statusBarItem.tooltip = `File not found: ${FILE_PATH}\n\nRun your slurm_monitor.sh or slurm_status_bar_emojis.sh script to create it. You can pass one or more cluster aliases.`;
            } else {
                console.error('Error reading file:', error);
                statusBarItem.text = '$(warning) Error reading file';
                statusBarItem.tooltip = `Error: ${error.message}`;
            }
        } else {
            const content = data.trim();
            if (content) {
                // Display the emoji status directly
                statusBarItem.text = content;
                statusBarItem.tooltip = `Slurm Job Status\n\nDisplays the merged status from the configured cluster aliases.\nUpdates every second.`;
            } else {
                statusBarItem.text = '$(circle-outline) Empty';
                statusBarItem.tooltip = 'Status file is empty';
            }
        }
        statusBarItem.show();
    });
}

export function deactivate() {
    console.log('Slurm Status Bar extension is deactivating');

    // Clean up file watcher
    if (fileWatcher) {
        fileWatcher.close();
        fileWatcher = undefined;
    }

    // Clean up interval timer
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = undefined;
    }
}
