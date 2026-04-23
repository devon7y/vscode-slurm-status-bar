import {
    CLUSTER_DISPLAY,
    FAIRSHARE_HISTORY_PATH,
    HISTORY_CLUSTERS,
    HISTORY_SERIES,
    SERIES_COLORS,
    SERIES_DASHARRAY,
    SERIES_DISPLAY,
} from '../constants';
import type {
    HistoryRow,
    JobHistoryData,
    JobSnapshotRow,
} from '../types';
import { DASHBOARD_STYLES } from './styles';
import { DASHBOARD_SCRIPT } from './script';

const CHART_WIDTH = 1120;
const CHART_HEIGHT = 620;

function humanizeJobMetricLabel(metricKey: string): string {
    return metricKey
        .split('_')
        .map((part) => {
            const lower = part.toLowerCase();
            if (lower === 'cpu' || lower === 'gpu') {
                return lower.toUpperCase();
            }
            if (lower === 'fir') { return 'Fir'; }
            if (lower === 'ror') { return 'Rorqual'; }
            if (lower === 'nibi') { return 'Nibi'; }
            if (lower === 'tril') { return 'Trillium'; }
            return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(' ');
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildDashboardPayload(
    historyRows: HistoryRow[],
    jobHistory: JobHistoryData,
    jobSnapshots: JobSnapshotRow[],
    nodeHistory: JobHistoryData,
): string {
    const payload = {
        chartWidth: CHART_WIDTH,
        chartHeight: CHART_HEIGHT,
        series: HISTORY_SERIES,
        seriesLabels: SERIES_DISPLAY,
        seriesColors: SERIES_COLORS,
        seriesDasharray: SERIES_DASHARRAY,
        clusters: HISTORY_CLUSTERS.map((cluster) => ({
            cluster,
            label: cluster === 'tril' ? 'Trillium' : CLUSTER_DISPLAY[cluster],
            cpu: `${cluster}_cpu`,
            gpu: `${cluster}_gpu`,
        })),
        historyRows: historyRows.map((row) => ({
            timestamp: row.timestamp,
            values: Object.fromEntries(
                HISTORY_SERIES.map((series) => [series, row.values[series] ?? null]),
            ),
        })),
        jobHistory: jobHistory.rows.map((row) => ({
            timestamp: row.timestamp,
            values: row.values,
        })),
        jobMetricKeys: jobHistory.metricKeys,
        jobMetricLabels: Object.fromEntries(
            jobHistory.metricKeys.map((key) => [key, humanizeJobMetricLabel(key)]),
        ),
        jobSnapshots,
        nodeHistory: nodeHistory.rows.map((row) => ({
            timestamp: row.timestamp,
            values: row.values,
        })),
        nodeMetricKeys: nodeHistory.metricKeys,
        nodeMetricLabels: Object.fromEntries(
            nodeHistory.metricKeys.map((key) => [key, humanizeJobMetricLabel(key)]),
        ),
    };
    return JSON.stringify(payload).replace(/</g, '\\u003c');
}

export function buildFairshareGraphHtml(
    historyRows: HistoryRow[],
    jobHistory: JobHistoryData,
    jobSnapshots: JobSnapshotRow[],
    nodeHistory: JobHistoryData,
): string {
    const bootstrap = buildDashboardPayload(historyRows, jobHistory, jobSnapshots, nodeHistory);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HPC Usage Dashboard</title>
    <style>${DASHBOARD_STYLES}</style>
</head>
<body>
    <h1>HPC Usage Dashboard</h1>
    <p class="subtle">Source: ${escapeHtml(FAIRSHARE_HISTORY_PATH)}</p>
    <div class="card">
        <div class="preset-row">
            <button class="preset-button" data-range="all">All</button>
            <button class="preset-button" data-range="1d">24H</button>
            <button class="preset-button active" data-range="7d">7D</button>
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
            <svg id="chart" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="Fairshare history chart"></svg>
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
    <script>window.__DASHBOARD__ = ${bootstrap};</script>
    <script>${DASHBOARD_SCRIPT}</script>
</body>
</html>`;
}
