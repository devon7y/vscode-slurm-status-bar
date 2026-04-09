import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let statusBarItem: vscode.StatusBarItem;
let fileWatcher: fs.FSWatcher | undefined;
let updateInterval: NodeJS.Timer | undefined;
let fairshareGraphPanel: vscode.WebviewPanel | undefined;
let currentStatusText = '';

const FILE_PATH = path.join(os.homedir(), '.slurm_status_bar.txt');
const FAIRSHARE_HISTORY_PATH = path.join(os.homedir(), '.slurm_fairshare_history.csv');
const JOB_HISTORY_PATH = path.join(os.homedir(), '.slurm_job_history.csv');
const JOB_SNAPSHOT_HISTORY_PATH = path.join(os.homedir(), '.slurm_job_snapshot_history.csv');
const NODE_HISTORY_PATH = path.join(os.homedir(), '.slurm_node_history.csv');
const UPDATE_INTERVAL_MS = 1000; // 1 second
const STATUS_BAR_PRIORITY = 10000;
const SHOW_FULL_STATUS_COMMAND = 'slurmStatusBar.showFullStatus';
const SHOW_FAIRSHARE_GRAPH_COMMAND = 'slurmStatusBar.showFairshareGraph';
const OPEN_FAIRSHARE_HISTORY_COMMAND = 'slurmStatusBar.openFairshareHistory';
const HISTORY_CLUSTERS = ['fir', 'ror', 'nibi', 'tril'] as const;
const FAIRSHARE_METRICS = ['cpu', 'gpu'] as const;
type HistoryCluster = typeof HISTORY_CLUSTERS[number];
type FairshareMetric = typeof FAIRSHARE_METRICS[number];
type HistorySeriesKey = `${HistoryCluster}_${FairshareMetric}`;
const HISTORY_SERIES: HistorySeriesKey[] = [
    'fir_cpu',
    'fir_gpu',
    'ror_cpu',
    'ror_gpu',
    'nibi_cpu',
    'nibi_gpu',
    'tril_cpu',
    'tril_gpu',
];
const STATUS_LABELS = ['Fir', 'Ror', 'Nibi', 'Tril'];
const SPARKLINE_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const MAX_TOOLTIP_HISTORY_POINTS = 24;
const CLUSTER_DISPLAY: Record<HistoryCluster, string> = {
    fir: 'Fir',
    ror: 'Ror',
    nibi: 'Nibi',
    tril: 'Tril',
};
const SERIES_DISPLAY: Record<HistorySeriesKey, string> = {
    fir_cpu: 'Fir CPU',
    fir_gpu: 'Fir GPU',
    ror_cpu: 'Ror CPU',
    ror_gpu: 'Ror GPU',
    nibi_cpu: 'Nibi CPU',
    nibi_gpu: 'Nibi GPU',
    tril_cpu: 'Trillium CPU',
    tril_gpu: 'Trillium GPU',
};
const SERIES_COLORS: Record<HistorySeriesKey, string> = {
    fir_cpu: '#ffb3b3',
    fir_gpu: '#ff6b6b',
    ror_cpu: '#9bd0ff',
    ror_gpu: '#4dabf7',
    nibi_cpu: '#9be7a7',
    nibi_gpu: '#51cf66',
    tril_cpu: '#ffd08a',
    tril_gpu: '#f59f00',
};
const SERIES_DASHARRAY: Record<HistorySeriesKey, string> = {
    fir_cpu: '8 5',
    fir_gpu: '',
    ror_cpu: '8 5',
    ror_gpu: '',
    nibi_cpu: '8 5',
    nibi_gpu: '',
    tril_cpu: '8 5',
    tril_gpu: '',
};

interface JobEntry {
    name: string;
    state: string;
    timer: string;
}

interface HistoryRow {
    timestamp: string;
    values: Partial<Record<HistorySeriesKey, number>>;
}

interface JobHistoryRow {
    timestamp: string;
    values: Record<string, number | undefined>;
}

interface JobHistoryData {
    metricKeys: string[];
    rows: JobHistoryRow[];
}

interface JobSnapshotRow {
    timestamp: string;
    remote: string;
    jobId: string;
    name: string;
    state: string;
    elapsedHours?: number;
    remainingHours?: number;
    timeLimitHours?: number;
    numNodes?: number;
    numCpus?: number;
    numGpus?: number;
    cpuHoursElapsed?: number;
    cpuHoursRemaining?: number;
    cpuHoursLimit?: number;
    gpuHoursElapsed?: number;
    gpuHoursRemaining?: number;
    gpuHoursLimit?: number;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('HPC Usage Dashboard extension is now active!');

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        STATUS_BAR_PRIORITY
    );
    statusBarItem.name = 'HPC Usage Dashboard';
    statusBarItem.tooltip = 'HPC Usage Dashboard';
    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(vscode.commands.registerCommand(SHOW_FULL_STATUS_COMMAND, async () => {
        if (!currentStatusText) {
            return;
        }

        const document = await vscode.workspace.openTextDocument({
            content: `${currentStatusText}\n`,
            language: 'text',
        });
        await vscode.window.showTextDocument(document, {
            preview: true,
            preserveFocus: false,
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand(SHOW_FAIRSHARE_GRAPH_COMMAND, async () => {
        const historyRows = await readHistoryRows();
        const jobHistory = await readJobHistory();
        const jobSnapshots = await readJobSnapshots();
        const nodeHistory = await readNodeHistory();
        if (fairshareGraphPanel) {
            fairshareGraphPanel.webview.html = buildFairshareGraphHtml(historyRows, jobHistory, jobSnapshots, nodeHistory);
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
            }
        );
        fairshareGraphPanel.onDidDispose(() => {
            fairshareGraphPanel = undefined;
        });
        fairshareGraphPanel.webview.html = buildFairshareGraphHtml(historyRows, jobHistory, jobSnapshots, nodeHistory);
    }));
    context.subscriptions.push(vscode.commands.registerCommand(OPEN_FAIRSHARE_HISTORY_COMMAND, async () => {
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(FAIRSHARE_HISTORY_PATH));
            await vscode.window.showTextDocument(document, {
                preview: true,
                preserveFocus: false,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Fairshare history file is not available yet.';
            void vscode.window.showInformationMessage(message);
        }
    }));

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
    void updateStatusBarInner();
}

async function updateStatusBarInner(): Promise<void> {
    try {
        const data = await fs.promises.readFile(FILE_PATH, 'utf8');
        const content = data.trim();
        if (content) {
            currentStatusText = content;
            statusBarItem.text = content;
            statusBarItem.tooltip = await buildTooltip(content);
            statusBarItem.command = SHOW_FAIRSHARE_GRAPH_COMMAND;
        } else {
            currentStatusText = '';
            statusBarItem.text = '$(circle-outline) Empty';
            statusBarItem.tooltip = 'Status file is empty';
            statusBarItem.command = undefined;
        }
    } catch (error) {
        currentStatusText = '';
        statusBarItem.command = undefined;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            statusBarItem.text = '$(circle-slash) No Slurm status';
            statusBarItem.tooltip = `File not found: ${FILE_PATH}\n\nRun your slurm_monitor.sh script to create it. You can pass one or more cluster aliases.`;
        } else {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Error reading file:', error);
            statusBarItem.text = '$(warning) Error reading file';
            statusBarItem.tooltip = `Error: ${message}`;
        }
    }
    statusBarItem.show();
}

async function buildTooltip(statusText: string): Promise<vscode.MarkdownString> {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = true;
    tooltip.supportThemeIcons = true;

    const jobs = parseJobs(statusText);
    const historyRows = await readHistoryRows();
    const latestHistoryTimestamp = historyRows.length > 0
        ? formatTimestamp(historyRows[historyRows.length - 1].timestamp)
        : 'No fairshare samples yet';

    tooltip.appendMarkdown('### $(graph-line) HPC Usage Dashboard\n\n');
    tooltip.appendCodeblock(statusText, 'text');

    if (jobs.length > 0) {
        const stateCounts = new Map<string, number>();
        for (const job of jobs) {
            stateCounts.set(job.state, (stateCounts.get(job.state) ?? 0) + 1);
        }
        const summary = Array.from(stateCounts.entries())
            .map(([state, count]) => `${state}: ${count}`)
            .join(', ');
        tooltip.appendMarkdown(`**Jobs:** ${jobs.length} total`);
        if (summary) {
            tooltip.appendMarkdown(` (${summary})`);
        }
        tooltip.appendMarkdown('\n\n');

        const jobLines = jobs.map((job) => `${job.name} | ${job.state} | ${job.timer}`);
        tooltip.appendCodeblock(jobLines.join('\n'), 'text');
    } else {
        tooltip.appendMarkdown('**Jobs:** No active jobs\n\n');
    }

    tooltip.appendMarkdown('### $(pulse) Fairshare History\n\n');
    tooltip.appendMarkdown(`**Latest fairshare sample:** ${latestHistoryTimestamp}\n\n`);
    tooltip.appendCodeblock(buildFairshareSummary(historyRows), 'text');
    tooltip.appendMarkdown('\n[Open full status](command:slurmStatusBar.showFullStatus) | [Open HPC usage dashboard](command:slurmStatusBar.showFairshareGraph) | [Open fairshare history CSV](command:slurmStatusBar.openFairshareHistory)');

    return tooltip;
}

function parseJobs(statusText: string): JobEntry[] {
    return statusText
        .split(' | ')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0 && !STATUS_LABELS.some((label) => segment.startsWith(`${label}: `)))
        .map((segment) => {
            const match = /^(.*?) \(([A-Z]+)\) (.+)$/.exec(segment);
            if (!match) {
                return undefined;
            }
            const [, name, state, timer] = match;
            return { name, state, timer };
        })
        .filter((job): job is JobEntry => Boolean(job));
}

async function readHistoryRows(): Promise<HistoryRow[]> {
    try {
        const content = await fs.promises.readFile(FAIRSHARE_HISTORY_PATH, 'utf8');
        return parseHistoryCsv(content);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('Error reading fairshare history:', error);
        }
        return [];
    }
}

async function readJobHistory(): Promise<JobHistoryData> {
    try {
        const content = await fs.promises.readFile(JOB_HISTORY_PATH, 'utf8');
        return parseJobHistoryCsv(content);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('Error reading job history:', error);
        }
        return { metricKeys: [], rows: [] };
    }
}

async function readJobSnapshots(): Promise<JobSnapshotRow[]> {
    try {
        const content = await fs.promises.readFile(JOB_SNAPSHOT_HISTORY_PATH, 'utf8');
        return parseJobSnapshotCsv(content);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('Error reading job snapshot history:', error);
        }
        return [];
    }
}

async function readNodeHistory(): Promise<JobHistoryData> {
    try {
        const content = await fs.promises.readFile(NODE_HISTORY_PATH, 'utf8');
        return parseJobHistoryCsv(content);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('Error reading node history:', error);
        }
        return { metricKeys: [], rows: [] };
    }
}

function parseHistoryCsv(content: string): HistoryRow[] {
    const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    if (lines.length < 2) {
        return [];
    }

    const header = parseCsvLine(lines[0]).map((column) => column.trim());
    const legacyHeader = ['timestamp', ...HISTORY_CLUSTERS];

    return lines.slice(1).map((line) => {
        const columns = parseCsvLine(line);
        const timestamp = columns[0] ?? '';
        const values: Partial<Record<HistorySeriesKey, number>> = {};

        if (header.length === legacyHeader.length && header.every((value, index) => value === legacyHeader[index])) {
            HISTORY_CLUSTERS.forEach((cluster, index) => {
                values[`${cluster}_gpu`] = parseMaybeNumber(columns[index + 1]);
            });
        } else {
            header.slice(1).forEach((column, index) => {
                if (HISTORY_SERIES.includes(column as HistorySeriesKey)) {
                    values[column as HistorySeriesKey] = parseMaybeNumber(columns[index + 1]);
                }
            });
        }

        return { timestamp, values };
    });
}

function parseMaybeNumber(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJobHistoryCsv(content: string): JobHistoryData {
    const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    if (lines.length < 2) {
        return { metricKeys: [], rows: [] };
    }

    const header = parseCsvLine(lines[0]).map((column) => column.trim());
    const metricKeys = header.slice(1);
    const rows = lines.slice(1).map((line) => {
        const columns = parseCsvLine(line);
        const values: Record<string, number | undefined> = {};
        metricKeys.forEach((key, index) => {
            values[key] = parseMaybeNumber(columns[index + 1]);
        });
        return {
            timestamp: columns[0] ?? '',
            values,
        };
    });

    return { metricKeys, rows };
}

function parseJobSnapshotCsv(content: string): JobSnapshotRow[] {
    const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    if (lines.length < 2) {
        return [];
    }

    const header = parseCsvLine(lines[0]).map((column) => column.trim());
    const columnIndex = new Map<string, number>();
    header.forEach((column, index) => {
        columnIndex.set(column, index);
    });

    const readColumn = (columns: string[], key: string): string => {
        const index = columnIndex.get(key);
        return index === undefined ? '' : (columns[index] ?? '');
    };
    const normalizeText = (value: string): string => value.trim().replace(/^'+|'+$/g, '');

    return lines.slice(1).map((line) => {
        const columns = parseCsvLine(line);
        return {
            timestamp: normalizeText(readColumn(columns, 'timestamp')),
            remote: normalizeText(readColumn(columns, 'remote')),
            jobId: normalizeText(readColumn(columns, 'job_id')),
            name: normalizeText(readColumn(columns, 'name')),
            state: normalizeText(readColumn(columns, 'state')),
            elapsedHours: parseMaybeNumber(readColumn(columns, 'elapsed_hours')),
            remainingHours: parseMaybeNumber(readColumn(columns, 'remaining_hours')),
            timeLimitHours: parseMaybeNumber(readColumn(columns, 'time_limit_hours')),
            numNodes: parseMaybeNumber(readColumn(columns, 'num_nodes')),
            numCpus: parseMaybeNumber(readColumn(columns, 'num_cpus')),
            numGpus: parseMaybeNumber(readColumn(columns, 'num_gpus')),
            cpuHoursElapsed: parseMaybeNumber(readColumn(columns, 'cpu_hours_elapsed')),
            cpuHoursRemaining: parseMaybeNumber(readColumn(columns, 'cpu_hours_remaining')),
            cpuHoursLimit: parseMaybeNumber(readColumn(columns, 'cpu_hours_limit')),
            gpuHoursElapsed: parseMaybeNumber(readColumn(columns, 'gpu_hours_elapsed')),
            gpuHoursRemaining: parseMaybeNumber(readColumn(columns, 'gpu_hours_remaining')),
            gpuHoursLimit: parseMaybeNumber(readColumn(columns, 'gpu_hours_limit')),
        };
    });
}

function parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') {
            const nextChar = line[index + 1];
            if (inQuotes && nextChar === '"') {
                current += '"';
                index += 1;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }
        if (char === ',' && !inQuotes) {
            values.push(current);
            current = '';
            continue;
        }
        current += char;
    }

    values.push(current);
    return values;
}

function humanizeJobMetricLabel(metricKey: string): string {
    return metricKey
        .split('_')
        .map((part) => {
            const lower = part.toLowerCase();
            if (lower === 'cpu' || lower === 'gpu') {
                return lower.toUpperCase();
            }
            if (lower === 'fir') {
                return 'Fir';
            }
            if (lower === 'ror') {
                return 'Rorqual';
            }
            if (lower === 'nibi') {
                return 'Nibi';
            }
            if (lower === 'tril') {
                return 'Trillium';
            }
            return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(' ');
}

function buildFairshareSummary(historyRows: HistoryRow[]): string {
    const lines = ['Series         Latest  Delta   Trend'];

    for (const series of HISTORY_SERIES) {
        const values = historyRows
            .map((row) => row.values[series])
            .filter((value): value is number => value !== undefined)
            .slice(-MAX_TOOLTIP_HISTORY_POINTS);
        const label = SERIES_DISPLAY[series].padEnd(13);

        if (values.length === 0) {
            lines.push(`${label} --      --      no data`);
            continue;
        }

        const latest = values[values.length - 1];
        const previous = values.length > 1 ? values[values.length - 2] : undefined;
        const delta = previous === undefined ? '--' : formatDelta(latest - previous);
        const sparkline = buildSparkline(values);

        lines.push(
            `${label} ${latest.toFixed(3).padEnd(6)} ${delta.padEnd(7)} ${sparkline}`
        );
    }

    return lines.join('\n');
}

function formatDelta(delta: number): string {
    const sign = delta >= 0 ? '+' : '';
    return `${sign}${delta.toFixed(3)}`;
}

function buildSparkline(values: number[]): string {
    if (values.length === 0) {
        return '';
    }
    if (values.length === 1) {
        return '█';
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min === max) {
        return '▅'.repeat(values.length);
    }

    return values.map((value) => {
        const normalized = (value - min) / (max - min);
        const index = Math.max(
            0,
            Math.min(SPARKLINE_BARS.length - 1, Math.round(normalized * (SPARKLINE_BARS.length - 1)))
        );
        return SPARKLINE_BARS[index];
    }).join('');
}

function formatTimestamp(rawTimestamp: string): string {
    const timestamp = new Date(rawTimestamp);
    if (Number.isNaN(timestamp.getTime())) {
        return rawTimestamp;
    }
    return timestamp.toLocaleString();
}

function buildFairshareGraphHtml(
    historyRows: HistoryRow[],
    jobHistory: JobHistoryData,
    jobSnapshots: JobSnapshotRow[],
    nodeHistory: JobHistoryData,
): string {
    const chartWidth = 720;
    const chartHeight = 720;
    const historyPayload = JSON.stringify(historyRows.map((row) => ({
        timestamp: row.timestamp,
        values: Object.fromEntries(
            HISTORY_SERIES.map((series) => [series, row.values[series] ?? null])
        ),
    })));
    const seriesPayload = JSON.stringify(HISTORY_SERIES);
    const labelPayload = JSON.stringify(SERIES_DISPLAY);
    const colorPayload = JSON.stringify(SERIES_COLORS);
    const dashPayload = JSON.stringify(SERIES_DASHARRAY);
    const clusterPayload = JSON.stringify(HISTORY_CLUSTERS.map((cluster) => ({
        cluster,
        label: cluster === 'tril' ? 'Trillium' : CLUSTER_DISPLAY[cluster],
        cpu: `${cluster}_cpu`,
        gpu: `${cluster}_gpu`,
    })));
    const jobHistoryPayload = JSON.stringify(jobHistory.rows.map((row) => ({
        timestamp: row.timestamp,
        values: row.values,
    })));
    const jobMetricKeysPayload = JSON.stringify(jobHistory.metricKeys);
    const jobMetricLabelsPayload = JSON.stringify(
        Object.fromEntries(jobHistory.metricKeys.map((key) => [key, humanizeJobMetricLabel(key)]))
    );
    const jobSnapshotPayload = JSON.stringify(jobSnapshots);
    const nodeHistoryPayload = JSON.stringify(nodeHistory.rows.map((row) => ({
        timestamp: row.timestamp,
        values: row.values,
    })));
    const nodeMetricKeysPayload = JSON.stringify(nodeHistory.metricKeys);
    const nodeMetricLabelsPayload = JSON.stringify(
        Object.fromEntries(nodeHistory.metricKeys.map((key) => [key, humanizeJobMetricLabel(key)]))
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HPC Usage Dashboard</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            margin: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        h1 {
            font-size: 18px;
            margin: 0 0 6px 0;
        }
        .subtle {
            color: var(--vscode-descriptionForeground);
            margin: 0 0 16px 0;
        }
        .card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 10px;
            padding: 16px;
            background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editor-foreground) 8%);
        }
        .controls {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 12px;
            margin-bottom: 16px;
        }
        .control-group {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .control-group label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .control-group input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 6px 8px;
        }
        .preset-row {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 12px;
        }
        .preset-button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 999px;
            padding: 6px 10px;
            cursor: pointer;
        }
        .preset-button.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .metric-row {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 10px;
            margin-bottom: 16px;
        }
        .metric-toggle {
            display: flex;
            align-items: center;
            gap: 10px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 8px 10px;
            user-select: none;
        }
        .metric-toggle input {
            margin: 0;
        }
        .metric-toggle-label {
            font-weight: 600;
        }
        .metric-select {
            min-width: 240px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 8px;
            padding: 8px 10px;
        }
        .secondary-button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 8px 10px;
            cursor: pointer;
        }
        .chart-shell {
            position: relative;
            width: min(78vmin, ${chartWidth}px);
            aspect-ratio: 1 / 1;
            margin: 0 auto;
        }
        .chart-shell svg {
            width: 100%;
            height: 100%;
            display: block;
        }
        .axis-label {
            fill: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .grid-line {
            stroke: var(--vscode-descriptionForeground);
            stroke-opacity: 0.38;
            stroke-width: 1.2;
            shape-rendering: crispEdges;
        }
        .legend {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 10px;
            margin-top: 16px;
        }
        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 8px 10px;
        }
        .legend-line {
            width: 18px;
            border-top-width: 3px;
            border-top-style: solid;
            border-top-color: currentColor;
            flex: 0 0 auto;
        }
        .legend-label {
            font-weight: 600;
        }
        .legend-value {
            margin-left: auto;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .footer {
            margin-top: 12px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .empty {
            color: var(--vscode-descriptionForeground);
        }
        .tooltip {
            position: absolute;
            pointer-events: none;
            background: var(--vscode-editorHoverWidget-background);
            color: var(--vscode-editorHoverWidget-foreground);
            border: 1px solid var(--vscode-editorHoverWidget-border);
            border-radius: 8px;
            padding: 10px 12px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
            font-size: 12px;
            line-height: 1.45;
            min-width: 180px;
            opacity: 0;
            transform: translate(12px, 12px);
            transition: opacity 90ms ease-out;
        }
        .tooltip.visible {
            opacity: 1;
        }
        .tooltip-title {
            font-weight: 700;
            margin-bottom: 6px;
        }
        .tooltip-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 4px;
        }
        .tooltip-swatch {
            width: 10px;
            height: 10px;
            border-radius: 999px;
            flex: 0 0 auto;
        }
        .tooltip-value {
            margin-left: auto;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .metrics {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-top: 12px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .selection-summary {
            margin-top: 16px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 10px;
            padding: 12px;
            background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%);
        }
        .selection-header {
            font-weight: 700;
            margin-bottom: 6px;
        }
        .selection-subtle {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            margin-bottom: 10px;
        }
        .selection-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 10px;
        }
        .selection-card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 10px;
        }
        .selection-card-title {
            font-weight: 700;
            margin-bottom: 6px;
        }
        .selection-metric {
            display: grid;
            grid-template-columns: 42px 70px 1fr;
            gap: 8px;
            align-items: baseline;
            font-size: 12px;
            margin-top: 4px;
        }
        .selection-metric strong {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .dashboard-stats {
            margin-top: 16px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 10px;
            padding: 12px;
            background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%);
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 10px;
        }
        .stats-card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 10px;
        }
        .stats-card-title {
            font-weight: 700;
            margin-bottom: 8px;
        }
        .stats-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 12px;
            align-items: baseline;
            font-size: 12px;
            margin-top: 4px;
        }
        .stats-row strong {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .stats-delta {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            margin-left: 6px;
        }
        .section-block {
            margin-top: 16px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 10px;
            padding: 12px;
            background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%);
        }
        .section-title {
            font-weight: 700;
            margin-bottom: 6px;
        }
        .section-subtle {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            margin-bottom: 10px;
        }
        .event-table-wrap {
            overflow-x: auto;
        }
        .event-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        .event-table th,
        .event-table td {
            padding: 8px 10px;
            border-top: 1px solid var(--vscode-panel-border);
            text-align: left;
            vertical-align: top;
        }
        .event-table th {
            color: var(--vscode-descriptionForeground);
            font-weight: 600;
        }
        .event-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            border-radius: 999px;
            padding: 2px 8px;
            font-size: 11px;
            font-weight: 700;
            border: 1px solid currentColor;
        }
        .event-legend {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 10px;
        }
        .corr-grid,
        .efficiency-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 10px;
        }
        .corr-card,
        .eff-card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 10px;
        }
        .corr-title,
        .eff-title {
            font-weight: 700;
            margin-bottom: 8px;
        }
        .corr-row,
        .eff-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 12px;
            font-size: 12px;
            margin-top: 4px;
        }
        .corr-row strong,
        .eff-row strong {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
    </style>
</head>
<body>
    <h1>HPC Usage Dashboard</h1>
    <p class="subtle">Source: ${escapeHtml(FAIRSHARE_HISTORY_PATH)}</p>
    <div class="card">
        <div class="preset-row">
            <button class="preset-button active" data-range="all">All</button>
            <button class="preset-button" data-range="1d">24H</button>
            <button class="preset-button" data-range="7d">7D</button>
            <button class="preset-button" data-range="30d">30D</button>
            <button class="preset-button" data-range="90d">90D</button>
            <button class="preset-button" data-range="1y">1Y</button>
        </div>
        <div class="controls">
            <div class="control-group">
                <label for="startDate">Start</label>
                <input id="startDate" type="datetime-local" />
            </div>
            <div class="control-group">
                <label for="endDate">End</label>
                <input id="endDate" type="datetime-local" />
            </div>
        </div>
        <div class="metric-row">
            <label class="metric-toggle">
                <input id="toggleCpu" type="checkbox" checked />
                <span class="metric-toggle-label">CPU</span>
            </label>
            <label class="metric-toggle">
                <input id="toggleGpu" type="checkbox" checked />
                <span class="metric-toggle-label">GPU</span>
            </label>
            <select id="aggregationSelect" class="metric-select">
                <option value="raw">Raw</option>
                <option value="15m">15m</option>
                <option value="1h">1h</option>
                <option value="6h">6h</option>
            </select>
            <select id="clusterSelect" class="metric-select">
                <option value="all">All HPCs</option>
                <option value="fir">Fir</option>
                <option value="ror">Rorqual</option>
                <option value="nibi">Nibi</option>
                <option value="tril">Trillium</option>
            </select>
            <select id="jobMetricSelect" class="metric-select"></select>
            <button id="clearSelection" class="secondary-button" type="button">Clear Selection</button>
        </div>
        <div class="chart-shell">
            <svg id="chart" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="Fairshare history chart"></svg>
            <div id="chartTooltip" class="tooltip"></div>
        </div>
        <div id="metrics" class="metrics"></div>
        <div id="legend" class="legend"></div>
        <div id="selectionSummary" class="selection-summary"></div>
        <div id="jobStats" class="dashboard-stats"></div>
        <div id="efficiencyView" class="section-block"></div>
        <div id="lagCorrelationView" class="section-block"></div>
        <div id="eventTableView" class="section-block"></div>
        <div class="footer">The graph auto-zooms the y-axis to the selected date range so shallow fairshare changes are easier to see. Hover over the chart to inspect exact values at the nearest recorded sample.</div>
    </div>
    <script>
        const HISTORY_DATA = ${historyPayload};
        const HISTORY_SERIES = ${seriesPayload};
        const SERIES_LABELS = ${labelPayload};
        const SERIES_COLORS = ${colorPayload};
        const SERIES_DASHARRAY = ${dashPayload};
        const CLUSTERS = ${clusterPayload};
        const JOB_DATA = ${jobHistoryPayload};
        const JOB_METRIC_KEYS = ${jobMetricKeysPayload};
        const JOB_METRIC_LABELS = ${jobMetricLabelsPayload};
        const JOB_SNAPSHOTS = ${jobSnapshotPayload};
        const NODE_DATA = ${nodeHistoryPayload};
        const NODE_METRIC_KEYS = ${nodeMetricKeysPayload};
        const NODE_METRIC_LABELS = ${nodeMetricLabelsPayload};
        const svg = document.getElementById('chart');
        const tooltip = document.getElementById('chartTooltip');
        const legend = document.getElementById('legend');
        const metrics = document.getElementById('metrics');
        const selectionSummary = document.getElementById('selectionSummary');
        const jobStats = document.getElementById('jobStats');
        const efficiencyView = document.getElementById('efficiencyView');
        const lagCorrelationView = document.getElementById('lagCorrelationView');
        const eventTableView = document.getElementById('eventTableView');
        const startInput = document.getElementById('startDate');
        const endInput = document.getElementById('endDate');
        const toggleCpu = document.getElementById('toggleCpu');
        const toggleGpu = document.getElementById('toggleGpu');
        const aggregationSelect = document.getElementById('aggregationSelect');
        const clusterSelect = document.getElementById('clusterSelect');
        const jobMetricSelect = document.getElementById('jobMetricSelect');
        const clearSelectionButton = document.getElementById('clearSelection');
        const presetButtons = Array.from(document.querySelectorAll('.preset-button'));
        const CHART = {
            width: ${chartWidth},
            height: ${chartHeight},
            padding: { top: 28, right: 28, bottom: 72, left: 72 },
        };
        let currentRows = [];
        let currentJobRows = [];
        let currentNodeRows = [];
        let currentSeries = [];
        let currentPlotWidth = 0;
        let currentXForIndex = () => CHART.padding.left;
        let currentSelectionRange = null;
        let isDragging = false;
        let dragAnchorIndex = null;
        let dragCurrentIndex = null;
        let currentHoveredIndex = null;
        let currentHoverUpdater = null;
        let currentSelectionHoverUpdater = null;
        let currentHideHover = null;
        const AGGREGATION_BUCKETS = {
            raw: 0,
            '15m': 15 * 60 * 1000,
            '1h': 60 * 60 * 1000,
            '6h': 6 * 60 * 60 * 1000,
        };
        const EVENT_LABELS = {
            submit: 'Submit',
            start: 'Start',
            end: 'End',
            queue_change: 'Queue Δ',
        };

        const allRows = HISTORY_DATA
            .map((row) => ({
                timestamp: row.timestamp,
                date: new Date(row.timestamp),
                values: row.values,
            }))
            .filter((row) => !Number.isNaN(row.date.getTime()));
        const allJobRows = JOB_DATA
            .map((row) => ({
                timestamp: row.timestamp,
                date: new Date(row.timestamp),
                values: row.values,
            }))
            .filter((row) => !Number.isNaN(row.date.getTime()));
        const allJobSnapshots = JOB_SNAPSHOTS
            .map((row) => ({
                ...row,
                date: new Date(row.timestamp),
            }))
            .filter((row) => !Number.isNaN(row.date.getTime()));
        const allNodeRows = NODE_DATA
            .map((row) => ({
                timestamp: row.timestamp,
                date: new Date(row.timestamp),
                values: row.values,
            }))
            .filter((row) => !Number.isNaN(row.date.getTime()));
        const OVERLAY_METRIC_KEYS = [...JOB_METRIC_KEYS, ...NODE_METRIC_KEYS];
        const OVERLAY_METRIC_LABELS = { ...JOB_METRIC_LABELS, ...NODE_METRIC_LABELS };
        const allEvents = deriveEvents(allJobSnapshots, allJobRows);

        function toInputValue(date) {
            const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
            return local.toISOString().slice(0, 16);
        }

        function formatTime(date) {
            return date.toLocaleString();
        }

        function formatValue(value) {
            return typeof value === 'number' ? value.toFixed(3) : '--';
        }

        function formatDelta(value) {
            if (typeof value !== 'number' || Number.isNaN(value)) {
                return '--';
            }
            const sign = value >= 0 ? '+' : '';
            return \`\${sign}\${value.toFixed(3)}\`;
        }

        function formatDuration(startDate, endDate) {
            const diffMs = Math.max(0, endDate.getTime() - startDate.getTime());
            const totalMinutes = Math.round(diffMs / 60000);
            const days = Math.floor(totalMinutes / (60 * 24));
            const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
            const minutes = totalMinutes % 60;
            if (days > 0) {
                return \`\${days}d \${hours}h \${minutes}m\`;
            }
            if (hours > 0) {
                return \`\${hours}h \${minutes}m\`;
            }
            return \`\${minutes}m\`;
        }

        function formatJobMetricValue(metricKey, value) {
            if (typeof value !== 'number' || Number.isNaN(value)) {
                return '--';
            }
            if (metricKey.includes('hours')) {
                return \`\${value.toFixed(3)}h\`;
            }
            return Number.isInteger(value) ? String(value) : value.toFixed(3);
        }

        function formatJobMetricDelta(metricKey, value) {
            if (typeof value !== 'number' || Number.isNaN(value)) {
                return '--';
            }
            if (metricKey.includes('hours')) {
                return \`\${value >= 0 ? '+' : ''}\${value.toFixed(3)}h\`;
            }
            return Number.isInteger(value)
                ? \`\${value >= 0 ? '+' : ''}\${Math.trunc(value)}\`
                : \`\${value >= 0 ? '+' : ''}\${value.toFixed(3)}\`;
        }

        function selectedJobMetric() {
            return jobMetricSelect.value || 'none';
        }

        function findNearestJobRow(date) {
            const sourceRows = currentJobRows.length > 0 ? currentJobRows : allJobRows;
            if (sourceRows.length === 0) {
                return null;
            }
            let best = null;
            let bestDelta = Number.POSITIVE_INFINITY;
            for (const row of sourceRows) {
                const delta = Math.abs(row.date.getTime() - date.getTime());
                if (delta < bestDelta) {
                    best = row;
                    bestDelta = delta;
                }
            }
            return bestDelta <= 120000 ? best : null;
        }

        function findNearestNodeRow(date) {
            const sourceRows = currentNodeRows.length > 0 ? currentNodeRows : allNodeRows;
            if (sourceRows.length === 0) {
                return null;
            }
            let best = null;
            let bestDelta = Number.POSITIVE_INFINITY;
            for (const row of sourceRows) {
                const delta = Math.abs(row.date.getTime() - date.getTime());
                if (delta < bestDelta) {
                    best = row;
                    bestDelta = delta;
                }
            }
            return bestDelta <= 120000 ? best : null;
        }

        function overlayMetricValueForRow(fairshareRow, metricKey) {
            if (!metricKey || metricKey === 'none') {
                return undefined;
            }
            if (JOB_METRIC_KEYS.includes(metricKey)) {
                const jobRow = findNearestJobRow(fairshareRow.date);
                return jobRow ? jobRow.values[metricKey] : undefined;
            }
            if (NODE_METRIC_KEYS.includes(metricKey)) {
                const nodeRow = findNearestNodeRow(fairshareRow.date);
                return nodeRow ? nodeRow.values[metricKey] : undefined;
            }
            return undefined;
        }

        function jobMetricValueForRow(fairshareRow, metricKey) {
            if (!JOB_METRIC_KEYS.includes(metricKey)) {
                return undefined;
            }
            const jobRow = findNearestJobRow(fairshareRow.date);
            return jobRow ? jobRow.values[metricKey] : undefined;
        }

        function initializeJobMetricSelect() {
            const options = ['<option value="none">No overlay metric</option>']
                .concat(OVERLAY_METRIC_KEYS.map((key) => \`<option value="\${key}">\${OVERLAY_METRIC_LABELS[key] || key}</option>\`));
            jobMetricSelect.innerHTML = options.join('');
            jobMetricSelect.value = 'none';
        }

        function selectedCluster() {
            return clusterSelect.value || 'all';
        }

        function selectedAggregationBucketMs() {
            return AGGREGATION_BUCKETS[aggregationSelect.value] || 0;
        }

        function rangeBounds() {
            return {
                start: startInput.value ? new Date(startInput.value) : null,
                end: endInput.value ? new Date(endInput.value) : null,
            };
        }

        function filterRowsByRange(rows) {
            const { start, end } = rangeBounds();
            return rows.filter((row) => {
                if (start && row.date < start) {
                    return false;
                }
                if (end && row.date > end) {
                    return false;
                }
                return true;
            });
        }

        function bucketStartMs(date, bucketMs) {
            if (bucketMs <= 0) {
                return date.getTime();
            }
            return Math.floor(date.getTime() / bucketMs) * bucketMs;
        }

        function aggregateFairshareRows(rows, bucketMs) {
            if (bucketMs <= 0 || rows.length <= 1) {
                return rows;
            }

            const buckets = new Map();
            for (const row of rows) {
                const bucketKey = bucketStartMs(row.date, bucketMs);
                let bucket = buckets.get(bucketKey);
                if (!bucket) {
                    bucket = {
                        bucketKey,
                        countBySeries: {},
                        sumBySeries: {},
                    };
                    buckets.set(bucketKey, bucket);
                }
                for (const seriesKey of HISTORY_SERIES) {
                    const value = row.values[seriesKey];
                    if (typeof value !== 'number') {
                        continue;
                    }
                    bucket.sumBySeries[seriesKey] = (bucket.sumBySeries[seriesKey] || 0) + value;
                    bucket.countBySeries[seriesKey] = (bucket.countBySeries[seriesKey] || 0) + 1;
                }
            }

            return Array.from(buckets.values())
                .sort((a, b) => a.bucketKey - b.bucketKey)
                .map((bucket) => {
                    const bucketEnd = bucket.bucketKey + bucketMs;
                    const values = {};
                    for (const seriesKey of HISTORY_SERIES) {
                        if (bucket.countBySeries[seriesKey]) {
                            values[seriesKey] = bucket.sumBySeries[seriesKey] / bucket.countBySeries[seriesKey];
                        }
                    }
                    return {
                        timestamp: new Date(bucketEnd).toISOString(),
                        date: new Date(bucketEnd),
                        bucketStart: new Date(bucket.bucketKey),
                        bucketEnd: new Date(bucketEnd),
                        values,
                    };
                });
        }

        function aggregateJobRows(rows, bucketMs) {
            if (bucketMs <= 0 || rows.length <= 1) {
                return rows;
            }

            const buckets = new Map();
            for (const row of rows) {
                const bucketKey = bucketStartMs(row.date, bucketMs);
                let bucket = buckets.get(bucketKey);
                if (!bucket) {
                    bucket = {
                        bucketKey,
                        sums: {},
                        counts: {},
                    };
                    buckets.set(bucketKey, bucket);
                }
                for (const key of JOB_METRIC_KEYS) {
                    const value = row.values[key];
                    if (typeof value !== 'number') {
                        continue;
                    }
                    bucket.sums[key] = (bucket.sums[key] || 0) + value;
                    bucket.counts[key] = (bucket.counts[key] || 0) + 1;
                }
            }

            return Array.from(buckets.values())
                .sort((a, b) => a.bucketKey - b.bucketKey)
                .map((bucket) => {
                    const bucketEnd = bucket.bucketKey + bucketMs;
                    const values = {};
                    for (const key of JOB_METRIC_KEYS) {
                        if (bucket.counts[key]) {
                            values[key] = bucket.sums[key] / bucket.counts[key];
                        }
                    }
                    return {
                        timestamp: new Date(bucketEnd).toISOString(),
                        date: new Date(bucketEnd),
                        bucketStart: new Date(bucket.bucketKey),
                        bucketEnd: new Date(bucketEnd),
                        values,
                    };
                });
        }

        function aggregateNodeRows(rows, bucketMs) {
            if (bucketMs <= 0 || rows.length <= 1) {
                return rows;
            }

            const buckets = new Map();
            for (const row of rows) {
                const bucketKey = bucketStartMs(row.date, bucketMs);
                let bucket = buckets.get(bucketKey);
                if (!bucket) {
                    bucket = {
                        bucketKey,
                        sums: {},
                        counts: {},
                    };
                    buckets.set(bucketKey, bucket);
                }
                for (const key of NODE_METRIC_KEYS) {
                    const value = row.values[key];
                    if (typeof value !== 'number') {
                        continue;
                    }
                    bucket.sums[key] = (bucket.sums[key] || 0) + value;
                    bucket.counts[key] = (bucket.counts[key] || 0) + 1;
                }
            }

            return Array.from(buckets.values())
                .sort((a, b) => a.bucketKey - b.bucketKey)
                .map((bucket) => {
                    const bucketEnd = bucket.bucketKey + bucketMs;
                    const values = {};
                    for (const key of NODE_METRIC_KEYS) {
                        if (bucket.counts[key]) {
                            values[key] = bucket.sums[key] / bucket.counts[key];
                        }
                    }
                    return {
                        timestamp: new Date(bucketEnd).toISOString(),
                        date: new Date(bucketEnd),
                        bucketStart: new Date(bucket.bucketKey),
                        bucketEnd: new Date(bucketEnd),
                        values,
                    };
                });
        }

        function currentRangeRows() {
            return aggregateFairshareRows(filterRowsByRange(allRows), selectedAggregationBucketMs());
        }

        function currentRangeJobRows() {
            return aggregateJobRows(filterRowsByRange(allJobRows), selectedAggregationBucketMs());
        }

        function currentRangeNodeRows() {
            return aggregateNodeRows(filterRowsByRange(allNodeRows), selectedAggregationBucketMs());
        }

        function metricForSeries(seriesKey) {
            return seriesKey.endsWith('_cpu') ? 'cpu' : 'gpu';
        }

        function visibleSeriesKeys() {
            const cluster = selectedCluster();
            return HISTORY_SERIES.filter((seriesKey) => {
                const metric = metricForSeries(seriesKey);
                const metricVisible = (metric === 'cpu' && toggleCpu.checked) || (metric === 'gpu' && toggleGpu.checked);
                const clusterVisible = cluster === 'all' || seriesKey.startsWith(\`\${cluster}_\`);
                return metricVisible && clusterVisible;
            });
        }

        function latestValueForSeries(rows, seriesKey) {
            const values = rows
                .map((row) => row.values[seriesKey])
                .filter((value) => typeof value === 'number');
            return values.length > 0 ? Number(values[values.length - 1]) : null;
        }

        function updateLegend(rows, activeKeys) {
            const sourceRows = rows.length > 0 ? rows : allRows;
            legend.innerHTML = activeKeys.map((seriesKey) => {
                const latest = latestValueForSeries(sourceRows, seriesKey);
                const dashStyle = SERIES_DASHARRAY[seriesKey] ? 'dashed' : 'solid';
                return \`
                    <div class="legend-item">
                        <span class="legend-line" style="color:\${SERIES_COLORS[seriesKey]}; border-top-style:\${dashStyle};"></span>
                        <span class="legend-label">\${SERIES_LABELS[seriesKey]}</span>
                        <span class="legend-value">\${latest === null ? '--' : latest.toFixed(3)}</span>
                    </div>
                \`;
            }).join('');
        }

        function clusterMetricKey(clusterKey, suffix) {
            return \`\${clusterKey}_\${suffix}\`;
        }

        function eventsClusterLabel(remote) {
            if (!remote || remote === 'all') {
                return 'All';
            }
            const match = CLUSTERS.find((cluster) => cluster.cluster === remote);
            return match ? match.label : remote;
        }

        function deriveEvents(snapshotRows, summaryRows) {
            const snapshotsByTimestamp = new Map();
            for (const row of snapshotRows) {
                const key = row.date.getTime();
                let bucket = snapshotsByTimestamp.get(key);
                if (!bucket) {
                    bucket = [];
                    snapshotsByTimestamp.set(key, bucket);
                }
                bucket.push(row);
            }

            const timeline = Array.from(new Set(summaryRows.map((row) => row.date.getTime()))).sort((a, b) => a - b);
            let previousJobs = new Map();
            let previousSummary = null;
            const events = [];

            for (const timestamp of timeline) {
                const date = new Date(timestamp);
                const currentJobs = new Map();
                for (const row of (snapshotsByTimestamp.get(timestamp) || [])) {
                    currentJobs.set(\`\${row.remote}:\${row.jobId}\`, row);
                }

                for (const [jobKey, job] of currentJobs.entries()) {
                    const previous = previousJobs.get(jobKey);
                    if (!previous) {
                        events.push({
                            type: 'submit',
                            date,
                            timestamp: date.toISOString(),
                            remote: job.remote,
                            jobId: job.jobId,
                            name: job.name,
                            fromState: null,
                            toState: job.state,
                            numCpus: job.numCpus,
                            numGpus: job.numGpus,
                            elapsedHours: job.elapsedHours,
                            remainingHours: job.remainingHours,
                            timeLimitHours: job.timeLimitHours,
                            gpuHoursRemaining: job.gpuHoursRemaining,
                            note: 'Job first appeared in active queue snapshots.',
                        });
                        if (job.state === 'R') {
                            events.push({
                                type: 'start',
                                date,
                                timestamp: date.toISOString(),
                                remote: job.remote,
                                jobId: job.jobId,
                                name: job.name,
                                fromState: null,
                                toState: job.state,
                                numCpus: job.numCpus,
                                numGpus: job.numGpus,
                                elapsedHours: job.elapsedHours,
                                remainingHours: job.remainingHours,
                                timeLimitHours: job.timeLimitHours,
                                gpuHoursRemaining: job.gpuHoursRemaining,
                                note: 'Job appeared already running.',
                            });
                        }
                        continue;
                    }

                    if (previous.state !== job.state && job.state === 'R') {
                        events.push({
                            type: 'start',
                            date,
                            timestamp: date.toISOString(),
                            remote: job.remote,
                            jobId: job.jobId,
                            name: job.name,
                            fromState: previous.state,
                            toState: job.state,
                            numCpus: job.numCpus,
                            numGpus: job.numGpus,
                            elapsedHours: job.elapsedHours,
                            remainingHours: job.remainingHours,
                            timeLimitHours: job.timeLimitHours,
                            gpuHoursRemaining: job.gpuHoursRemaining,
                            note: \`State changed \${previous.state} → \${job.state}.\`,
                        });
                    }
                }

                for (const [jobKey, previous] of previousJobs.entries()) {
                    if (!currentJobs.has(jobKey)) {
                        events.push({
                            type: 'end',
                            date,
                            timestamp: date.toISOString(),
                            remote: previous.remote,
                            jobId: previous.jobId,
                            name: previous.name,
                            fromState: previous.state,
                            toState: null,
                            numCpus: previous.numCpus,
                            numGpus: previous.numGpus,
                            elapsedHours: previous.elapsedHours,
                            remainingHours: previous.remainingHours,
                            timeLimitHours: previous.timeLimitHours,
                            gpuHoursRemaining: previous.gpuHoursRemaining,
                            note: 'Job disappeared from active queue snapshots.',
                        });
                    }
                }

                const currentSummary = summaryRows.find((row) => row.date.getTime() === timestamp) || null;
                if (previousSummary && currentSummary) {
                    const totalDelta = (currentSummary.values.total_jobs || 0) - (previousSummary.values.total_jobs || 0);
                    if (Math.abs(totalDelta) >= 2) {
                        events.push({
                            type: 'queue_change',
                            date,
                            timestamp: date.toISOString(),
                            remote: 'all',
                            note: \`Total jobs changed by \${totalDelta >= 0 ? '+' : ''}\${totalDelta}.\`,
                            deltaJobs: totalDelta,
                            beforeJobs: previousSummary.values.total_jobs || 0,
                            afterJobs: currentSummary.values.total_jobs || 0,
                        });
                    }

                    for (const cluster of CLUSTERS) {
                        const key = clusterMetricKey(cluster.cluster, 'jobs');
                        const before = previousSummary.values[key] || 0;
                        const after = currentSummary.values[key] || 0;
                        const delta = after - before;
                        if (Math.abs(delta) >= 2) {
                            events.push({
                                type: 'queue_change',
                                date,
                                timestamp: date.toISOString(),
                                remote: cluster.cluster,
                                note: \`\${cluster.label} jobs changed by \${delta >= 0 ? '+' : ''}\${delta}.\`,
                                deltaJobs: delta,
                                beforeJobs: before,
                                afterJobs: after,
                            });
                        }
                    }
                }

                previousJobs = currentJobs;
                previousSummary = currentSummary;
            }

            return events.sort((left, right) => left.date.getTime() - right.date.getTime());
        }

        function filteredEventsForRange(startDate, endDate) {
            const cluster = selectedCluster();
            return allEvents.filter((event) => {
                if (event.date < startDate || event.date > endDate) {
                    return false;
                }
                if (cluster === 'all') {
                    return true;
                }
                return event.remote === cluster;
            });
        }

        function rowForSelectionRange(rows) {
            const selection = displayedSelection();
            if (selection && rows[selection.startIndex] && rows[selection.endIndex]) {
                return {
                    startRow: rows[selection.startIndex],
                    endRow: rows[selection.endIndex],
                };
            }
            return rows.length > 0
                ? {
                    startRow: rows[0],
                    endRow: rows[rows.length - 1],
                }
                : null;
        }

        function uniqueJobsInEvents(events, cluster) {
            const identifiers = new Set();
            for (const event of events) {
                if (!event.jobId || !event.remote) {
                    continue;
                }
                if (cluster !== 'all' && event.remote !== cluster) {
                    continue;
                }
                identifiers.add(\`\${event.remote}:\${event.jobId}\`);
            }
            return identifiers.size;
        }

        function formatEventType(type) {
            return EVENT_LABELS[type] || type;
        }

        function eventAccentColor(event) {
            if (!event.remote || event.remote === 'all') {
                return '#bfc7d5';
            }
            const clusterKey = \`\${event.remote}_gpu\`;
            return SERIES_COLORS[clusterKey] || '#bfc7d5';
        }

        function eventPillStyle(event) {
            const color = eventAccentColor(event);
            return \`color:\${color}; border-color:\${color}; background:\${color}22;\`;
        }

        function eventShortSymbol(type) {
            if (type === 'submit') {
                return '+';
            }
            if (type === 'start') {
                return '>';
            }
            if (type === 'end') {
                return 'x';
            }
            return '~';
        }

        function formatHoursValue(value) {
            return typeof value === 'number' ? \`\${value.toFixed(2)}h\` : '--';
        }

        function displayedSelection() {
            if (isDragging && dragAnchorIndex !== null && dragCurrentIndex !== null) {
                return {
                    startIndex: Math.min(dragAnchorIndex, dragCurrentIndex),
                    endIndex: Math.max(dragAnchorIndex, dragCurrentIndex),
                };
            }
            return currentSelectionRange;
        }

        function clearSelection() {
            currentSelectionRange = null;
            isDragging = false;
            dragAnchorIndex = null;
            dragCurrentIndex = null;
            currentHoveredIndex = null;
            renderSelectionVisual();
            renderSelectionSummary();
            renderJobStats(currentRows);
        }

        function setActivePreset(range) {
            presetButtons.forEach((button) => {
                button.classList.toggle('active', button.dataset.range === range);
            });
        }

        function applyPreset(range) {
            if (allRows.length === 0) {
                return;
            }
            setActivePreset(range);
            const lastDate = allRows[allRows.length - 1].date;
            if (range === 'all') {
                startInput.value = '';
                endInput.value = '';
                clearSelection();
                render();
                return;
            }
            const durationMap = {
                '1d': 24 * 60 * 60 * 1000,
                '7d': 7 * 24 * 60 * 60 * 1000,
                '30d': 30 * 24 * 60 * 60 * 1000,
                '90d': 90 * 24 * 60 * 60 * 1000,
                '1y': 365 * 24 * 60 * 60 * 1000,
            };
            const duration = durationMap[range];
            const startDate = new Date(lastDate.getTime() - duration);
            startInput.value = toInputValue(startDate);
            endInput.value = toInputValue(lastDate);
            clearSelection();
            render();
        }

        function rowIndexFromClientX(clientX) {
            if (currentRows.length <= 1) {
                return 0;
            }
            const rect = svg.getBoundingClientRect();
            const relativeX = clientX - rect.left;
            const chartX = (relativeX / rect.width) * CHART.width;
            const clampedX = Math.max(CHART.padding.left, Math.min(CHART.width - CHART.padding.right, chartX));
            const normalized = currentPlotWidth === 0 ? 0 : (clampedX - CHART.padding.left) / currentPlotWidth;
            return Math.max(0, Math.min(currentRows.length - 1, Math.round(normalized * (currentRows.length - 1))));
        }

        function renderSelectionVisual() {
            const selectionRect = document.getElementById('selectionRect');
            if (!selectionRect || currentRows.length === 0) {
                return;
            }
            const selection = displayedSelection();
            if (!selection) {
                selectionRect.setAttribute('opacity', '0');
                return;
            }

            let left = currentXForIndex(selection.startIndex);
            let right = currentXForIndex(selection.endIndex);
            if (currentRows.length === 1) {
                left = CHART.padding.left;
                right = CHART.width - CHART.padding.right;
            }

            selectionRect.setAttribute('x', String(Math.min(left, right)));
            selectionRect.setAttribute('y', String(CHART.padding.top));
            selectionRect.setAttribute('width', String(Math.max(3, Math.abs(right - left))));
            selectionRect.setAttribute('height', String(CHART.height - CHART.padding.top - CHART.padding.bottom));
            selectionRect.setAttribute('opacity', '0.14');
        }

        function renderSelectionSummary() {
            const selection = displayedSelection();
            const activeKeys = visibleSeriesKeys();
            if (!selection || currentRows.length === 0) {
                selectionSummary.innerHTML = '<div class="selection-header">Selection</div><div class="selection-subtle">Drag across the graph to measure net fairshare change over a specific time range.</div>';
                return;
            }

            const startRow = currentRows[selection.startIndex];
            const endRow = currentRows[selection.endIndex];
            const cards = CLUSTERS.map((cluster) => {
                const parts = [];
                for (const seriesKey of [cluster.cpu, cluster.gpu]) {
                    if (!activeKeys.includes(seriesKey)) {
                        continue;
                    }
                    const startValue = startRow.values[seriesKey];
                    const endValue = endRow.values[seriesKey];
                    if (typeof startValue !== 'number' || typeof endValue !== 'number') {
                        continue;
                    }
                    const metricLabel = seriesKey.endsWith('_cpu') ? 'CPU' : 'GPU';
                    parts.push(\`
                        <div class="selection-metric">
                            <span>\${metricLabel}</span>
                            <strong>\${formatDelta(endValue - startValue)}</strong>
                            <span>\${startValue.toFixed(3)} → \${endValue.toFixed(3)}</span>
                        </div>
                    \`);
                }
                if (parts.length === 0) {
                    return '';
                }
                return \`
                    <div class="selection-card">
                        <div class="selection-card-title">\${cluster.label}</div>
                        \${parts.join('')}
                    </div>
                \`;
            }).join('');

            selectionSummary.innerHTML = \`
                <div class="selection-header">Selection: \${formatTime(startRow.date)} to \${formatTime(endRow.date)}</div>
                <div class="selection-subtle">Duration: \${formatDuration(startRow.date, endRow.date)} | Samples: \${selection.endIndex - selection.startIndex + 1}</div>
                <div class="selection-grid">\${cards || '<div class="empty">No visible fairshare values in this selection.</div>'}</div>
            \`;
        }

        function renderJobStats(rows) {
            const metricKey = selectedJobMetric();
            const latestFairshareRow = rows.length > 0 ? rows[rows.length - 1] : allRows[allRows.length - 1];
            const latestJobRow = latestFairshareRow ? findNearestJobRow(latestFairshareRow.date) : null;

            if (!latestJobRow) {
                jobStats.innerHTML = '<div class="selection-header">Job Statistics</div><div class="selection-subtle">No aligned job-history samples are available for the current range.</div>';
                return;
            }

            const selection = displayedSelection();
            const selectedStart = selection && currentRows[selection.startIndex]
                ? findNearestJobRow(currentRows[selection.startIndex].date)
                : null;
            const selectedEnd = selection && currentRows[selection.endIndex]
                ? findNearestJobRow(currentRows[selection.endIndex].date)
                : null;
            const selectionMetricDelta = (
                selection
                && metricKey !== 'none'
                && currentRows[selection.startIndex]
                && currentRows[selection.endIndex]
                && typeof overlayMetricValueForRow(currentRows[selection.startIndex], metricKey) === 'number'
                && typeof overlayMetricValueForRow(currentRows[selection.endIndex], metricKey) === 'number'
            )
                ? Number(overlayMetricValueForRow(currentRows[selection.endIndex], metricKey))
                    - Number(overlayMetricValueForRow(currentRows[selection.startIndex], metricKey))
                : undefined;

            const selectionDeltaForMetric = (key) => {
                if (!selection || !selectedStart || !selectedEnd) {
                    return undefined;
                }
                const startValue = selectedStart.values[key];
                const endValue = selectedEnd.values[key];
                if (typeof startValue !== 'number' || typeof endValue !== 'number') {
                    return undefined;
                }
                return Number(endValue) - Number(startValue);
            };

            const formatStatsValue = (key) => {
                const current = formatJobMetricValue(key, latestJobRow.values[key]);
                const delta = selectionDeltaForMetric(key);
                if (delta === undefined) {
                    return current;
                }
                return \`\${current} <span class="stats-delta">(\${formatJobMetricDelta(key, delta)})</span>\`;
            };

            const clusterCards = CLUSTERS.map((cluster) => ({
                title: \`\${cluster.label} Jobs\`,
                rows: [
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_jobs\`] || 'Jobs', formatStatsValue(\`\${cluster.cluster}_jobs\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_running_jobs\`] || 'Running Jobs', formatStatsValue(\`\${cluster.cluster}_running_jobs\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_pending_jobs\`] || 'Pending Jobs', formatStatsValue(\`\${cluster.cluster}_pending_jobs\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_other_jobs\`] || 'Other Jobs', formatStatsValue(\`\${cluster.cluster}_other_jobs\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_cpu_count\`] || 'CPU Count', formatStatsValue(\`\${cluster.cluster}_cpu_count\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_gpu_count\`] || 'GPU Count', formatStatsValue(\`\${cluster.cluster}_gpu_count\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_remaining_hours\`] || 'Remaining Hours', formatStatsValue(\`\${cluster.cluster}_remaining_hours\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_cpu_hours_remaining\`] || 'CPU Hours Remaining', formatStatsValue(\`\${cluster.cluster}_cpu_hours_remaining\`)],
                    [JOB_METRIC_LABELS[\`\${cluster.cluster}_gpu_hours_remaining\`] || 'GPU Hours Remaining', formatStatsValue(\`\${cluster.cluster}_gpu_hours_remaining\`)],
                ],
            }));

            const cards = [
                {
                    title: 'Overall Jobs',
                    rows: [
                        [JOB_METRIC_LABELS.total_jobs || 'Total Jobs', formatStatsValue('total_jobs')],
                        [JOB_METRIC_LABELS.running_jobs || 'Running Jobs', formatStatsValue('running_jobs')],
                        [JOB_METRIC_LABELS.pending_jobs || 'Pending Jobs', formatStatsValue('pending_jobs')],
                        [JOB_METRIC_LABELS.other_jobs || 'Other Jobs', formatStatsValue('other_jobs')],
                        [JOB_METRIC_LABELS.total_cpu_count || 'Total CPU Count', formatStatsValue('total_cpu_count')],
                        [JOB_METRIC_LABELS.total_gpu_count || 'Total GPU Count', formatStatsValue('total_gpu_count')],
                    ],
                },
                {
                    title: 'Overall Time',
                    rows: [
                        [JOB_METRIC_LABELS.total_elapsed_hours || 'Total Elapsed Hours', formatStatsValue('total_elapsed_hours')],
                        [JOB_METRIC_LABELS.total_remaining_hours || 'Total Remaining Hours', formatStatsValue('total_remaining_hours')],
                        [JOB_METRIC_LABELS.total_time_limit_hours || 'Total Time Limit Hours', formatStatsValue('total_time_limit_hours')],
                    ],
                },
                {
                    title: 'Overall CPU Hours',
                    rows: [
                        [JOB_METRIC_LABELS.total_cpu_hours_elapsed || 'CPU Hours Elapsed', formatStatsValue('total_cpu_hours_elapsed')],
                        [JOB_METRIC_LABELS.total_cpu_hours_remaining || 'CPU Hours Remaining', formatStatsValue('total_cpu_hours_remaining')],
                        [JOB_METRIC_LABELS.total_cpu_hours_limit || 'CPU Hours Limit', formatStatsValue('total_cpu_hours_limit')],
                    ],
                },
                {
                    title: 'Overall GPU Hours',
                    rows: [
                        [JOB_METRIC_LABELS.total_gpu_hours_elapsed || 'GPU Hours Elapsed', formatStatsValue('total_gpu_hours_elapsed')],
                        [JOB_METRIC_LABELS.total_gpu_hours_remaining || 'GPU Hours Remaining', formatStatsValue('total_gpu_hours_remaining')],
                        [JOB_METRIC_LABELS.total_gpu_hours_limit || 'GPU Hours Limit', formatStatsValue('total_gpu_hours_limit')],
                    ],
                },
                ...clusterCards,
            ];

            if (metricKey !== 'none') {
                cards.push({
                    title: 'Overlay Metric',
                    rows: [
                        ['Metric', OVERLAY_METRIC_LABELS[metricKey] || metricKey],
                        ['Current', formatJobMetricValue(metricKey, overlayMetricValueForRow(latestFairshareRow, metricKey))],
                        ['Selection Δ', selectionMetricDelta === undefined ? '--' : formatJobMetricDelta(metricKey, selectionMetricDelta)],
                        ['Selection span', selection ? formatDuration(currentRows[selection.startIndex].date, currentRows[selection.endIndex].date) : '--'],
                    ],
                });
            }

            jobStats.innerHTML = \`
                <div class="selection-header">Job Statistics</div>
                <div class="selection-subtle">Latest aligned job snapshot: \${formatTime(latestJobRow.date)}</div>
                <div class="stats-grid">\${cards.map((card) => \`
                    <div class="stats-card">
                        <div class="stats-card-title">\${card.title}</div>
                        \${card.rows.map(([label, value]) => \`<div class="stats-row"><span>\${label}</span><strong>\${value}</strong></div>\`).join('')}
                    </div>
                \`).join('')}</div>
            \`;
        }

        function analysisRowsWithinSelection(rows) {
            const selection = displayedSelection();
            if (!selection) {
                return rows;
            }
            return rows.slice(selection.startIndex, selection.endIndex + 1);
        }

        function integrateMetric(rows, metricKey) {
            if (rows.length < 2) {
                return 0;
            }
            let total = 0;
            for (let index = 1; index < rows.length; index += 1) {
                const previous = rows[index - 1];
                const current = rows[index];
                const previousValue = jobMetricValueForRow(previous, metricKey);
                const currentValue = jobMetricValueForRow(current, metricKey);
                if (typeof previousValue !== 'number' || typeof currentValue !== 'number') {
                    continue;
                }
                const durationHours = Math.max(0, current.date.getTime() - previous.date.getTime()) / 3600000;
                total += ((previousValue + currentValue) / 2) * durationHours;
            }
            return total;
        }

        function averageMetric(rows, metricKey) {
            const values = rows
                .map((row) => jobMetricValueForRow(row, metricKey))
                .filter((value) => typeof value === 'number');
            if (values.length === 0) {
                return undefined;
            }
            return values.reduce((sum, value) => sum + value, 0) / values.length;
        }

        function fairshareDelta(rows, seriesKey) {
            if (rows.length < 2) {
                return undefined;
            }
            const startValue = rows[0].values[seriesKey];
            const endValue = rows[rows.length - 1].values[seriesKey];
            if (typeof startValue !== 'number' || typeof endValue !== 'number') {
                return undefined;
            }
            return endValue - startValue;
        }

        function idleRecoveryRate(rows, clusterKey, seriesKey) {
            if (rows.length < 2) {
                return undefined;
            }
            const jobMetricKey = clusterMetricKey(clusterKey, 'jobs');
            let totalPositiveDelta = 0;
            let idleHours = 0;
            for (let index = 1; index < rows.length; index += 1) {
                const previous = rows[index - 1];
                const current = rows[index];
                const previousJobs = jobMetricValueForRow(previous, jobMetricKey);
                const currentJobs = jobMetricValueForRow(current, jobMetricKey);
                const previousFairshare = previous.values[seriesKey];
                const currentFairshare = current.values[seriesKey];
                if (
                    typeof previousJobs !== 'number'
                    || typeof currentJobs !== 'number'
                    || typeof previousFairshare !== 'number'
                    || typeof currentFairshare !== 'number'
                ) {
                    continue;
                }
                if (previousJobs === 0 && currentJobs === 0) {
                    const delta = currentFairshare - previousFairshare;
                    if (delta > 0) {
                        totalPositiveDelta += delta;
                    }
                    idleHours += Math.max(0, current.date.getTime() - previous.date.getTime()) / 3600000;
                }
            }
            if (idleHours <= 0) {
                return undefined;
            }
            return totalPositiveDelta / idleHours;
        }

        function analysisClusters() {
            const cluster = selectedCluster();
            if (cluster === 'all') {
                return CLUSTERS.map((item) => item.cluster);
            }
            return [cluster];
        }

        function renderEfficiencyMetrics(rows) {
            const analysisRows = analysisRowsWithinSelection(rows);
            if (analysisRows.length < 2) {
                efficiencyView.innerHTML = '<div class="section-title">Efficiency Metrics</div><div class="section-subtle">Select a range with at least two samples to compute efficiency metrics.</div>';
                return;
            }

            const range = rowForSelectionRange(rows);
            const events = range ? filteredEventsForRange(range.startRow.date, range.endRow.date) : [];
            const cards = analysisClusters().map((clusterKey) => {
                const clusterLabel = eventsClusterLabel(clusterKey);
                const cpuSeriesKey = \`\${clusterKey}_cpu\`;
                const gpuSeriesKey = \`\${clusterKey}_gpu\`;
                const cpuDelta = fairshareDelta(analysisRows, cpuSeriesKey);
                const gpuDelta = fairshareDelta(analysisRows, gpuSeriesKey);
                const cpuHoursUsed = integrateMetric(analysisRows, clusterMetricKey(clusterKey, 'cpu_count'));
                const gpuHoursUsed = integrateMetric(analysisRows, clusterMetricKey(clusterKey, 'gpu_count'));
                const distinctJobs = uniqueJobsInEvents(events, clusterKey);
                const averageJobs = averageMetric(analysisRows, clusterMetricKey(clusterKey, 'jobs'));
                const gpuIdleRecovery = idleRecoveryRate(analysisRows, clusterKey, gpuSeriesKey);
                const cpuIdleRecovery = idleRecoveryRate(analysisRows, clusterKey, cpuSeriesKey);
                const latestRow = analysisRows[analysisRows.length - 1];
                const schedulableNodes = overlayMetricValueForRow(latestRow, clusterMetricKey(clusterKey, 'schedulable_gpu_nodes'));
                const downNodes = overlayMetricValueForRow(latestRow, clusterMetricKey(clusterKey, 'down_gpu_nodes'));
                const drainNodes = overlayMetricValueForRow(latestRow, clusterMetricKey(clusterKey, 'drain_gpu_nodes'));

                return \`
                    <div class="eff-card">
                        <div class="eff-title">\${clusterLabel}</div>
                        <div class="eff-row"><span>CPU fairshare Δ</span><strong>\${cpuDelta === undefined ? '--' : formatDelta(cpuDelta)}</strong></div>
                        <div class="eff-row"><span>GPU fairshare Δ</span><strong>\${gpuDelta === undefined ? '--' : formatDelta(gpuDelta)}</strong></div>
                        <div class="eff-row"><span>CPU fairshare Δ / CPU-hour</span><strong>\${cpuDelta === undefined || cpuHoursUsed <= 0 ? '--' : formatDelta(cpuDelta / cpuHoursUsed)}</strong></div>
                        <div class="eff-row"><span>GPU fairshare Δ / GPU-hour</span><strong>\${gpuDelta === undefined || gpuHoursUsed <= 0 ? '--' : formatDelta(gpuDelta / gpuHoursUsed)}</strong></div>
                        <div class="eff-row"><span>GPU fairshare Δ / distinct job</span><strong>\${gpuDelta === undefined || distinctJobs <= 0 ? '--' : formatDelta(gpuDelta / distinctJobs)}</strong></div>
                        <div class="eff-row"><span>Average active jobs</span><strong>\${averageJobs === undefined ? '--' : averageJobs.toFixed(2)}</strong></div>
                        <div class="eff-row"><span>Schedulable GPU nodes</span><strong>\${formatJobMetricValue(clusterMetricKey(clusterKey, 'schedulable_gpu_nodes'), schedulableNodes)}</strong></div>
                        <div class="eff-row"><span>Down GPU nodes</span><strong>\${formatJobMetricValue(clusterMetricKey(clusterKey, 'down_gpu_nodes'), downNodes)}</strong></div>
                        <div class="eff-row"><span>Drain GPU nodes</span><strong>\${formatJobMetricValue(clusterMetricKey(clusterKey, 'drain_gpu_nodes'), drainNodes)}</strong></div>
                        <div class="eff-row"><span>Idle recovery rate (CPU/hr)</span><strong>\${cpuIdleRecovery === undefined ? '--' : formatDelta(cpuIdleRecovery)}</strong></div>
                        <div class="eff-row"><span>Idle recovery rate (GPU/hr)</span><strong>\${gpuIdleRecovery === undefined ? '--' : formatDelta(gpuIdleRecovery)}</strong></div>
                    </div>
                \`;
            }).join('');

            efficiencyView.innerHTML = \`
                <div class="section-title">Efficiency Metrics</div>
                <div class="section-subtle">Calculated over the current visible range\${displayedSelection() ? ' and drag selection' : ''}. GPU-hour metrics integrate the observed GPU counts over time.</div>
                <div class="efficiency-grid">\${cards || '<div class="empty">No efficiency metrics are available for this range.</div>'}</div>
            \`;
        }

        function pearsonCorrelation(xs, ys) {
            if (xs.length !== ys.length || xs.length < 3) {
                return undefined;
            }
            const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
            const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
            let numerator = 0;
            let denominatorX = 0;
            let denominatorY = 0;
            for (let index = 0; index < xs.length; index += 1) {
                const dx = xs[index] - meanX;
                const dy = ys[index] - meanY;
                numerator += dx * dy;
                denominatorX += dx * dx;
                denominatorY += dy * dy;
            }
            if (denominatorX <= 0 || denominatorY <= 0) {
                return undefined;
            }
            return numerator / Math.sqrt(denominatorX * denominatorY);
        }

        function computeBestLag(rows, fairshareSeriesKey, jobMetricKey) {
            const stepMinutes = Math.max(1, Math.round(selectedAggregationBucketMs() > 0
                ? selectedAggregationBucketMs() / 60000
                : ((rows.length > 1 ? rows[1].date.getTime() - rows[0].date.getTime() : 60000) / 60000)));
            const lagMinutes = [0, stepMinutes, stepMinutes * 2, stepMinutes * 4, stepMinutes * 8, stepMinutes * 12];
            let best = undefined;

            for (const lagMinute of Array.from(new Set(lagMinutes))) {
                const offset = Math.max(0, Math.round(lagMinute / stepMinutes));
                const xs = [];
                const ys = [];
                for (let index = 0; index + offset < rows.length; index += 1) {
                    const metricValue = overlayMetricValueForRow(rows[index], jobMetricKey);
                    const fairshareValue = rows[index + offset].values[fairshareSeriesKey];
                    if (typeof metricValue !== 'number' || typeof fairshareValue !== 'number') {
                        continue;
                    }
                    xs.push(metricValue);
                    ys.push(fairshareValue);
                }
                const correlation = pearsonCorrelation(xs, ys);
                if (correlation === undefined) {
                    continue;
                }
                if (!best || Math.abs(correlation) > Math.abs(best.correlation)) {
                    best = {
                        lagMinutes: lagMinute,
                        correlation,
                        samples: xs.length,
                    };
                }
            }

            return best;
        }

        function renderLagCorrelation(rows) {
            const analysisRows = analysisRowsWithinSelection(rows);
            if (analysisRows.length < 4) {
                lagCorrelationView.innerHTML = '<div class="section-title">Lag / Correlation</div><div class="section-subtle">At least four samples are needed for lag analysis.</div>';
                return;
            }

            const cards = analysisClusters().map((clusterKey) => {
                const preferredSeries = toggleGpu.checked ? \`\${clusterKey}_gpu\` : \`\${clusterKey}_cpu\`;
                const fallbackSeries = toggleGpu.checked ? \`\${clusterKey}_cpu\` : \`\${clusterKey}_gpu\`;
                const fairshareSeriesKey = analysisRows.some((row) => typeof row.values[preferredSeries] === 'number')
                    ? preferredSeries
                    : fallbackSeries;
                const jobsMetricKey = clusterMetricKey(clusterKey, 'jobs');
                const gpuHoursMetricKey = clusterMetricKey(clusterKey, 'gpu_hours_remaining');
                const schedulableNodesMetricKey = clusterMetricKey(clusterKey, 'schedulable_gpu_nodes');
                const downNodesMetricKey = clusterMetricKey(clusterKey, 'down_gpu_nodes');
                const jobsLag = computeBestLag(analysisRows, fairshareSeriesKey, jobsMetricKey);
                const gpuLag = computeBestLag(analysisRows, fairshareSeriesKey, gpuHoursMetricKey);
                const schedulableLag = computeBestLag(analysisRows, fairshareSeriesKey, schedulableNodesMetricKey);
                const downLag = computeBestLag(analysisRows, fairshareSeriesKey, downNodesMetricKey);

                return \`
                    <div class="corr-card">
                        <div class="corr-title">\${eventsClusterLabel(clusterKey)} using \${SERIES_LABELS[fairshareSeriesKey] || fairshareSeriesKey}</div>
                        <div class="corr-row"><span>Best lag vs job count</span><strong>\${jobsLag ? \`\${jobsLag.lagMinutes}m (r=\${jobsLag.correlation.toFixed(3)})\` : '--'}</strong></div>
                        <div class="corr-row"><span>Samples used</span><strong>\${jobsLag ? jobsLag.samples : '--'}</strong></div>
                        <div class="corr-row"><span>Best lag vs GPU-hours remaining</span><strong>\${gpuLag ? \`\${gpuLag.lagMinutes}m (r=\${gpuLag.correlation.toFixed(3)})\` : '--'}</strong></div>
                        <div class="corr-row"><span>Samples used</span><strong>\${gpuLag ? gpuLag.samples : '--'}</strong></div>
                        <div class="corr-row"><span>Best lag vs schedulable GPU nodes</span><strong>\${schedulableLag ? \`\${schedulableLag.lagMinutes}m (r=\${schedulableLag.correlation.toFixed(3)})\` : '--'}</strong></div>
                        <div class="corr-row"><span>Samples used</span><strong>\${schedulableLag ? schedulableLag.samples : '--'}</strong></div>
                        <div class="corr-row"><span>Best lag vs down GPU nodes</span><strong>\${downLag ? \`\${downLag.lagMinutes}m (r=\${downLag.correlation.toFixed(3)})\` : '--'}</strong></div>
                        <div class="corr-row"><span>Samples used</span><strong>\${downLag ? downLag.samples : '--'}</strong></div>
                    </div>
                \`;
            }).join('');

            lagCorrelationView.innerHTML = \`
                <div class="section-title">Lag / Correlation</div>
                <div class="section-subtle">Positive lag means the selected job metric leads fairshare by that many minutes.</div>
                <div class="corr-grid">\${cards || '<div class="empty">No lag/correlation results are available for this range.</div>'}</div>
            \`;
        }

        function renderEventTable(rows) {
            const range = rowForSelectionRange(rows);
            if (!range) {
                eventTableView.innerHTML = '<div class="section-title">Job Event Log</div><div class="section-subtle">No rows are available for the current range.</div>';
                return;
            }

            const events = filteredEventsForRange(range.startRow.date, range.endRow.date)
                .sort((left, right) => right.date.getTime() - left.date.getTime());
            const visibleEvents = events.slice(0, 80);

            const legend = Object.entries(EVENT_LABELS).map(([type, label]) => (
                \`<span class="event-pill">\${eventShortSymbol(type)} \${label}</span>\`
            )).join('');

            const rowsHtml = visibleEvents.map((event) => {
                const jobLabel = event.jobId ? \`\${event.name || '--'} (#\${event.jobId})\` : '--';
                const stateLabel = event.type === 'queue_change'
                    ? \`\${event.beforeJobs ?? '--'} → \${event.afterJobs ?? '--'}\`
                    : [event.fromState || '', event.toState || ''].filter(Boolean).join(' → ') || '--';
                return \`
                    <tr>
                        <td>\${formatTime(event.date)}</td>
                        <td>\${eventsClusterLabel(event.remote)}</td>
                        <td><span class="event-pill" style="\${eventPillStyle(event)}">\${eventShortSymbol(event.type)} \${formatEventType(event.type)}</span></td>
                        <td>\${jobLabel}</td>
                        <td>\${stateLabel}</td>
                        <td>\${event.numCpus ?? '--'}</td>
                        <td>\${event.numGpus ?? '--'}</td>
                        <td>\${formatHoursValue(event.elapsedHours)}</td>
                        <td>\${formatHoursValue(event.remainingHours)}</td>
                        <td>\${event.note || '--'}</td>
                    </tr>
                \`;
            }).join('');

            eventTableView.innerHTML = \`
                <div class="section-title">Job Event Log</div>
                <div class="section-subtle">Showing \${visibleEvents.length} of \${events.length} events in the current \${displayedSelection() ? 'selection' : 'visible range'}.</div>
                <div class="event-legend">\${legend}</div>
                <div class="event-table-wrap">
                    <table class="event-table">
                        <thead>
                            <tr>
                                <th>Time</th>
                                <th>HPC</th>
                                <th>Event</th>
                                <th>Job</th>
                                <th>State / Jobs</th>
                                <th>CPU</th>
                                <th>GPU</th>
                                <th>Elapsed</th>
                                <th>Remaining</th>
                                <th>Notes</th>
                            </tr>
                        </thead>
                        <tbody>\${rowsHtml || '<tr><td colspan="10" class="empty">No job events were found for this range.</td></tr>'}</tbody>
                    </table>
                </div>
            \`;
        }

        function render() {
            const rows = currentRangeRows();
            currentRows = rows;
            currentJobRows = currentRangeJobRows();
            currentNodeRows = currentRangeNodeRows();
            const plotWidth = CHART.width - CHART.padding.left - CHART.padding.right;
            const plotHeight = CHART.height - CHART.padding.top - CHART.padding.bottom;
            currentPlotWidth = plotWidth;
            const activeSeriesKeys = visibleSeriesKeys();
            const jobMetricKey = selectedJobMetric();
            updateLegend(rows, activeSeriesKeys);
            const allValues = rows.flatMap((row) =>
                activeSeriesKeys
                    .map((seriesKey) => row.values[seriesKey])
                    .filter((value) => typeof value === 'number')
            );
            const overlayValues = rows
                .map((row) => overlayMetricValueForRow(row, jobMetricKey))
                .filter((value) => typeof value === 'number');

            if (activeSeriesKeys.length === 0) {
                svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" class="axis-label">Enable CPU or GPU to draw the graph.</text>';
                metrics.innerHTML = '<span>Series shown: <strong>0</strong></span>';
                tooltip.classList.remove('visible');
                renderSelectionSummary();
                renderJobStats(rows);
                renderEfficiencyMetrics(rows);
                renderLagCorrelation(rows);
                renderEventTable(rows);
                return;
            }

            if (rows.length === 0 || allValues.length === 0) {
                svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" class="axis-label">No fairshare samples in this date range.</text>';
                metrics.innerHTML = '';
                tooltip.classList.remove('visible');
                renderSelectionSummary();
                renderJobStats(rows);
                renderEfficiencyMetrics(rows);
                renderLagCorrelation(rows);
                renderEventTable(rows);
                return;
            }

            const rawMin = Math.min(...allValues);
            const rawMax = Math.max(...allValues);
            const spread = Math.max(rawMax - rawMin, 0.02);
            const padding = spread * 0.12;
            const yMin = Math.max(0, rawMin - padding);
            const yMax = rawMax + padding;
            const effectiveSpread = Math.max(yMax - yMin, 0.02);

            const xForIndex = (index) => {
                if (rows.length <= 1) {
                    return CHART.padding.left + plotWidth / 2;
                }
                return CHART.padding.left + (index / (rows.length - 1)) * plotWidth;
            };
            currentXForIndex = xForIndex;

            const yForValue = (value) => {
                const normalized = (value - yMin) / effectiveSpread;
                return CHART.padding.top + plotHeight - normalized * plotHeight;
            };

            const gridFractions = [0, 0.25, 0.5, 0.75, 1];
            const grid = gridFractions.map((fraction) => {
                const value = yMin + effectiveSpread * fraction;
                return { value, y: yForValue(value) };
            });
            const overlayMin = overlayValues.length > 0 ? Math.min(...overlayValues) : 0;
            const overlayMax = overlayValues.length > 0 ? Math.max(...overlayValues) : 0;
            const overlaySpread = Math.max(overlayMax - overlayMin, 1);
            const overlayPadding = overlaySpread * 0.12;
            const overlayYMin = overlayValues.length > 0 ? Math.max(0, overlayMin - overlayPadding) : 0;
            const overlayYMax = overlayValues.length > 0 ? overlayMax + overlayPadding : 1;
            const overlayEffectiveSpread = Math.max(overlayYMax - overlayYMin, 1);
            const overlayYForValue = (value) => {
                const normalized = (value - overlayYMin) / overlayEffectiveSpread;
                return CHART.padding.top + plotHeight - normalized * plotHeight;
            };

            const series = activeSeriesKeys.map((seriesKey) => ({
                seriesKey,
                label: SERIES_LABELS[seriesKey],
                color: SERIES_COLORS[seriesKey],
                dasharray: SERIES_DASHARRAY[seriesKey],
                points: rows
                    .map((row, index) => ({
                        rowIndex: index,
                        timestamp: row.timestamp,
                        date: row.date,
                        value: row.values[seriesKey],
                    }))
                    .filter((point) => typeof point.value === 'number')
                    .map((point) => ({ ...point, value: Number(point.value) })),
            }));
            currentSeries = series;
            const overlaySeries = rows
                .map((row, index) => ({
                    rowIndex: index,
                    date: row.date,
                    value: overlayMetricValueForRow(row, jobMetricKey),
                }))
                .filter((point) => typeof point.value === 'number')
                .map((point) => ({ ...point, value: Number(point.value) }));

            const firstTimestamp = formatTime(rows[0].date);
            const lastTimestamp = formatTime(rows[rows.length - 1].date);

            const xTicks = rows.length <= 1 ? [0] : [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
            const xTickLabels = Array.from(new Set(xTicks)).map((index) => ({
                x: xForIndex(index),
                label: formatTime(rows[index].date),
                anchor: index === 0 ? 'start' : (index === rows.length - 1 ? 'end' : 'middle'),
            }));
            const verticalGridFractions = [0, 0.25, 0.5, 0.75, 1];
            const verticalGridLines = verticalGridFractions.map((fraction) => (
                CHART.padding.left + plotWidth * fraction
            ));

            const polylines = series.map((entry) => {
                if (entry.points.length === 0) {
                    return '';
                }
                const polyline = entry.points
                    .map((point) => \`\${xForIndex(point.rowIndex)},\${yForValue(point.value)}\`)
                    .join(' ');
                const dashAttribute = entry.dasharray ? \` stroke-dasharray="\${entry.dasharray}"\` : '';
                return \`<polyline fill="none" stroke="\${entry.color}" stroke-width="3" points="\${polyline}" stroke-linejoin="round" stroke-linecap="round"\${dashAttribute}></polyline>\`;
            }).join('');
            const overlayPolyline = overlaySeries.length > 0
                ? \`<polyline fill="none" stroke="#bfc7d5" stroke-width="2.5" points="\${overlaySeries.map((point) => \`\${xForIndex(point.rowIndex)},\${overlayYForValue(point.value)}\`).join(' ')}" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"></polyline>\`
                : '';
            const overlayGrid = overlayValues.length > 0
                ? gridFractions.map((fraction) => {
                    const value = overlayYMin + overlayEffectiveSpread * fraction;
                    const y = overlayYForValue(value);
                    return \`<text class="axis-label" x="\${CHART.width - CHART.padding.right + 10}" y="\${y + 4}" text-anchor="start">\${formatJobMetricValue(jobMetricKey, value)}</text>\`;
                }).join('')
                : '';
            const markerEvents = filteredEventsForRange(rows[0].date, rows[rows.length - 1].date);
            const markerStackByIndex = new Map();
            const positionedEvents = markerEvents.map((event) => {
                let bestIndex = 0;
                let bestDelta = Number.POSITIVE_INFINITY;
                for (let index = 0; index < rows.length; index += 1) {
                    const delta = Math.abs(rows[index].date.getTime() - event.date.getTime());
                    if (delta < bestDelta) {
                        bestDelta = delta;
                        bestIndex = index;
                    }
                }
                const stack = markerStackByIndex.get(bestIndex) || 0;
                markerStackByIndex.set(bestIndex, stack + 1);
                return {
                    ...event,
                    rowIndex: bestIndex,
                    stack,
                };
            });
            const eventMarkerSvg = positionedEvents.map((event) => {
                const color = eventAccentColor(event);
                const x = xForIndex(event.rowIndex);
                const y = CHART.padding.top + 10 + Math.min(event.stack, 2) * 10;
                if (event.type === 'submit') {
                    return \`<circle cx="\${x}" cy="\${y}" r="4.5" fill="\${color}" opacity="0.95" stroke="var(--vscode-editor-background)" stroke-width="1.2"></circle>\`;
                }
                if (event.type === 'start') {
                    return \`<polygon points="\${x},\${y - 5} \${x - 5},\${y + 4} \${x + 5},\${y + 4}" fill="\${color}" opacity="0.95" stroke="var(--vscode-editor-background)" stroke-width="1.2"></polygon>\`;
                }
                if (event.type === 'end') {
                    return \`<rect x="\${x - 4}" y="\${y - 4}" width="8" height="8" fill="none" stroke="\${color}" stroke-width="2.2" opacity="0.95"></rect>\`;
                }
                return \`<polygon points="\${x},\${y - 5} \${x - 5},\${y} \${x},\${y + 5} \${x + 5},\${y}" fill="none" stroke="\${color}" stroke-width="2" opacity="0.95"></polygon>\`;
            }).join('');
            const eventGuideSvg = positionedEvents
                .filter((event) => event.type === 'start' || event.type === 'end')
                .map((event) => {
                    const color = eventAccentColor(event);
                    const x = xForIndex(event.rowIndex);
                    const dasharray = event.type === 'end' ? '4 4' : '';
                    const dashAttribute = dasharray ? \` stroke-dasharray="\${dasharray}"\` : '';
                    return \`<line x1="\${x}" y1="\${CHART.padding.top}" x2="\${x}" y2="\${CHART.padding.top + plotHeight}" stroke="\${color}" stroke-width="2.4" opacity="1"\${dashAttribute}></line>\`;
                })
                .join('');

            svg.innerHTML = \`
                \${eventGuideSvg}
                \${verticalGridLines.map((x) => \`<line class="grid-line" x1="\${x}" y1="\${CHART.padding.top}" x2="\${x}" y2="\${CHART.padding.top + plotHeight}"></line>\`).join('')}
                \${grid.map((line) => \`
                    <line class="grid-line" x1="\${CHART.padding.left}" y1="\${line.y}" x2="\${CHART.width - CHART.padding.right}" y2="\${line.y}"></line>
                    <text class="axis-label" x="\${CHART.padding.left - 10}" y="\${line.y + 4}" text-anchor="end">\${line.value.toFixed(3)}</text>
                \`).join('')}
                <line class="grid-line" x1="\${CHART.padding.left}" y1="\${CHART.padding.top}" x2="\${CHART.padding.left}" y2="\${CHART.padding.top + plotHeight}"></line>
                <line class="grid-line" x1="\${CHART.padding.left}" y1="\${CHART.padding.top + plotHeight}" x2="\${CHART.width - CHART.padding.right}" y2="\${CHART.padding.top + plotHeight}"></line>
                <line class="grid-line" x1="\${CHART.width - CHART.padding.right}" y1="\${CHART.padding.top}" x2="\${CHART.width - CHART.padding.right}" y2="\${CHART.padding.top + plotHeight}"></line>
                \${polylines}
                \${overlayPolyline}
                \${overlayGrid}
                \${eventMarkerSvg}
                <rect id="selectionRect" x="0" y="0" width="0" height="0" fill="var(--vscode-textLink-activeForeground)" opacity="0"></rect>
                <line id="hoverLine" x1="0" y1="\${CHART.padding.top}" x2="0" y2="\${CHART.padding.top + plotHeight}" stroke="var(--vscode-editorCursor-foreground)" stroke-width="1.2" stroke-dasharray="4 4" opacity="0"></line>
                <g id="hoverPoints"></g>
                <rect id="hoverOverlay" x="\${CHART.padding.left}" y="\${CHART.padding.top}" width="\${plotWidth}" height="\${plotHeight}" fill="transparent"></rect>
                \${xTickLabels.map((tick) => \`<text class="axis-label" x="\${tick.x}" y="\${CHART.height - 24}" text-anchor="\${tick.anchor}">\${tick.label}</text>\`).join('')}
                <text class="axis-label" x="\${CHART.padding.left}" y="\${CHART.height - 8}" text-anchor="start">Start: \${firstTimestamp}</text>
                <text class="axis-label" x="\${CHART.width - CHART.padding.right}" y="\${CHART.height - 8}" text-anchor="end">End: \${lastTimestamp}</text>
            \`;

            metrics.innerHTML = [
                \`<span>Samples: <strong>\${rows.length}</strong></span>\`,
                \`<span>Series shown: <strong>\${activeSeriesKeys.length}</strong></span>\`,
                \`<span>Aggregation: <strong>\${aggregationSelect.value.toUpperCase()}</strong></span>\`,
                \`<span>Scope: <strong>\${selectedCluster() === 'all' ? 'All HPCs' : eventsClusterLabel(selectedCluster())}</strong></span>\`,
                \`<span>Events: <strong>\${markerEvents.length}</strong></span>\`,
                \`<span>Visible fairshare range: <strong>\${yMin.toFixed(3)} - \${yMax.toFixed(3)}</strong></span>\`,
                \`<span>Overlay: <strong>\${jobMetricKey === 'none' ? 'off' : (OVERLAY_METRIC_LABELS[jobMetricKey] || jobMetricKey)}</strong></span>\`,
                \`<span>Y-axis auto-zoom: <strong>on</strong></span>\`
            ].join('');

            const hoverOverlay = document.getElementById('hoverOverlay');
            const hoverLine = document.getElementById('hoverLine');
            const hoverPoints = document.getElementById('hoverPoints');

            function hideHover() {
                tooltip.classList.remove('visible');
                hoverLine.setAttribute('opacity', '0');
                hoverPoints.innerHTML = '';
            }

            function renderHoverForRowIndex(rowIndex, clientX, clientY) {
                currentHoveredIndex = rowIndex;
                const row = rows[rowIndex];
                const x = xForIndex(rowIndex);
                const selection = displayedSelection();
                const isSelectionEnd = selection && rowIndex === selection.endIndex;
                const selectionStartRow = selection ? rows[selection.startIndex] : null;

                hoverLine.setAttribute('x1', String(x));
                hoverLine.setAttribute('x2', String(x));
                hoverLine.setAttribute('opacity', '1');

                hoverPoints.innerHTML = series
                    .filter((entry) => typeof row.values[entry.seriesKey] === 'number')
                    .map((entry) => {
                        const value = Number(row.values[entry.seriesKey]);
                        return \`<circle cx="\${x}" cy="\${yForValue(value)}" r="5" fill="\${entry.color}" stroke="var(--vscode-editor-background)" stroke-width="2"></circle>\`;
                    })
                    .join('');

                const tooltipRows = series
                    .filter((entry) => typeof row.values[entry.seriesKey] === 'number')
                    .map((entry) => \`
                        <div class="tooltip-row">
                            <span class="tooltip-swatch" style="background:\${entry.color};"></span>
                            <span>\${entry.label}</span>
                            <span class="tooltip-value">\${Number(row.values[entry.seriesKey]).toFixed(3)}\${isSelectionEnd && selectionStartRow && typeof selectionStartRow.values[entry.seriesKey] === 'number' ? \` (\${formatDelta(Number(row.values[entry.seriesKey]) - Number(selectionStartRow.values[entry.seriesKey]))})\` : ''}</span>
                        </div>
                    \`)
                    .join('');
                const overlayValue = overlayMetricValueForRow(row, jobMetricKey);
                const overlayDelta = (isSelectionEnd && selectionStartRow && typeof overlayValue === 'number')
                    ? (() => {
                        const startValue = overlayMetricValueForRow(selectionStartRow, jobMetricKey);
                        return typeof startValue === 'number' ? overlayValue - startValue : undefined;
                    })()
                    : undefined;
                const overlayRow = (jobMetricKey !== 'none' && typeof overlayValue === 'number')
                    ? \`<div class="tooltip-row"><span class="tooltip-swatch" style="background:#bfc7d5;"></span><span>\${OVERLAY_METRIC_LABELS[jobMetricKey] || jobMetricKey}</span><span class="tooltip-value">\${formatJobMetricValue(jobMetricKey, overlayValue)}\${overlayDelta === undefined ? '' : \` (\${formatJobMetricDelta(jobMetricKey, overlayDelta)})\`}</span></div>\`
                    : '';
                const eventRows = positionedEvents
                    .filter((event) => event.rowIndex === rowIndex)
                    .slice(0, 6)
                    .map((event) => \`<div class="tooltip-row"><span class="tooltip-swatch" style="background:\${eventAccentColor(event)};"></span><span>\${eventShortSymbol(event.type)} \${formatEventType(event.type)} • \${eventsClusterLabel(event.remote)}</span><span class="tooltip-value">\${event.jobId ? \`#\${event.jobId}\` : (event.deltaJobs >= 0 ? \`+\${event.deltaJobs}\` : \`\${event.deltaJobs}\`)}</span></div>\`)
                    .join('');

                tooltip.innerHTML = \`
                    <div class="tooltip-title">\${formatTime(row.date)}</div>
                    \${tooltipRows || '<div class="tooltip-row">No values</div>'}
                    \${overlayRow}
                    \${eventRows}
                \`;
                tooltip.classList.add('visible');

                const tooltipRect = tooltip.getBoundingClientRect();
                const containerRect = svg.parentElement.getBoundingClientRect();
                const svgRect = svg.getBoundingClientRect();
                const defaultLeft = ((x / CHART.width) * svgRect.width) + (svgRect.left - containerRect.left) + 14;
                const defaultTop = ((CHART.padding.top / CHART.height) * svgRect.height) + (svgRect.top - containerRect.top) + 14;
                const left = Math.min(
                    containerRect.width - tooltipRect.width - 12,
                    Math.max(12, (typeof clientX === 'number' ? clientX - containerRect.left + 14 : defaultLeft))
                );
                const top = Math.min(
                    containerRect.height - tooltipRect.height - 12,
                    Math.max(12, (typeof clientY === 'number' ? clientY - containerRect.top + 14 : defaultTop))
                );
                tooltip.style.left = \`\${left}px\`;
                tooltip.style.top = \`\${top}px\`;
            }

            function showSelectionEndHover() {
                const selection = displayedSelection();
                if (!selection) {
                    hideHover();
                    return;
                }
                renderHoverForRowIndex(selection.endIndex);
            }

            function updateHover(clientX, clientY) {
                renderHoverForRowIndex(rowIndexFromClientX(clientX), clientX, clientY);
            }

            currentHoverUpdater = updateHover;
            currentSelectionHoverUpdater = showSelectionEndHover;
            currentHideHover = hideHover;

            hoverOverlay.addEventListener('mousemove', (event) => updateHover(event.clientX, event.clientY));
            hoverOverlay.addEventListener('mouseenter', (event) => updateHover(event.clientX, event.clientY));
            hoverOverlay.addEventListener('mouseleave', () => {
                if (!isDragging) {
                    if (displayedSelection()) {
                        showSelectionEndHover();
                    } else {
                        hideHover();
                    }
                }
            });
            hoverOverlay.addEventListener('mousedown', (event) => {
                if (event.button !== 0) {
                    return;
                }
                isDragging = true;
                dragAnchorIndex = rowIndexFromClientX(event.clientX);
                dragCurrentIndex = dragAnchorIndex;
                renderSelectionVisual();
                renderSelectionSummary();
                updateHover(event.clientX, event.clientY);
                event.preventDefault();
            });
            renderSelectionVisual();
            renderSelectionSummary();
            renderJobStats(rows);
            renderEfficiencyMetrics(rows);
            renderLagCorrelation(rows);
            renderEventTable(rows);
            if (displayedSelection()) {
                showSelectionEndHover();
            } else if (currentHoveredIndex !== null && currentHoveredIndex < rows.length) {
                renderHoverForRowIndex(currentHoveredIndex);
            } else {
                hideHover();
            }
        }

        presetButtons.forEach((button) => {
            button.addEventListener('click', () => applyPreset(button.dataset.range || 'all'));
        });
        startInput.addEventListener('change', () => {
            setActivePreset('custom');
            clearSelection();
            render();
        });
        endInput.addEventListener('change', () => {
            setActivePreset('custom');
            clearSelection();
            render();
        });
        toggleCpu.addEventListener('change', () => {
            clearSelection();
            render();
        });
        toggleGpu.addEventListener('change', () => {
            clearSelection();
            render();
        });
        aggregationSelect.addEventListener('change', () => {
            clearSelection();
            render();
        });
        clusterSelect.addEventListener('change', () => {
            clearSelection();
            render();
        });
        jobMetricSelect.addEventListener('change', () => render());
        clearSelectionButton.addEventListener('click', () => {
            clearSelection();
            render();
        });
        document.addEventListener('mousemove', (event) => {
            if (!isDragging) {
                return;
            }
            dragCurrentIndex = rowIndexFromClientX(event.clientX);
            renderSelectionVisual();
            renderSelectionSummary();
            renderJobStats(currentRows);
            if (currentHoverUpdater) {
                currentHoverUpdater(event.clientX, event.clientY);
            }
        });
        document.addEventListener('mouseup', () => {
            if (!isDragging) {
                return;
            }
            isDragging = false;
            if (dragAnchorIndex === null || dragCurrentIndex === null) {
                clearSelection();
                return;
            }
            currentSelectionRange = {
                startIndex: Math.min(dragAnchorIndex, dragCurrentIndex),
                endIndex: Math.max(dragAnchorIndex, dragCurrentIndex),
            };
            dragAnchorIndex = null;
            dragCurrentIndex = null;
            render();
        });

        initializeJobMetricSelect();
        if (allRows.length > 0) {
            render();
        } else {
            metrics.innerHTML = '<span>No fairshare history samples are available yet.</span>';
            updateLegend([], visibleSeriesKeys());
            renderSelectionSummary();
            renderJobStats([]);
            svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" class="axis-label">No fairshare history samples are available yet.</text>';
        }
    </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
