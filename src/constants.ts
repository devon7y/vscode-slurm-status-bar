import * as path from 'path';
import * as os from 'os';

export const FILE_PATH = path.join(os.homedir(), '.slurm_status_bar.txt');
export const FAIRSHARE_HISTORY_PATH = path.join(os.homedir(), '.slurm_fairshare_history.csv');
export const JOB_HISTORY_PATH = path.join(os.homedir(), '.slurm_job_history.csv');
export const JOB_SNAPSHOT_HISTORY_PATH = path.join(os.homedir(), '.slurm_job_snapshot_history.csv');
export const NODE_HISTORY_PATH = path.join(os.homedir(), '.slurm_node_history.csv');

export const UPDATE_INTERVAL_MS = 1000;
export const STATUS_BAR_PRIORITY = 10000;

export const SHOW_FULL_STATUS_COMMAND = 'slurmStatusBar.showFullStatus';
export const SHOW_FAIRSHARE_GRAPH_COMMAND = 'slurmStatusBar.showFairshareGraph';
export const OPEN_FAIRSHARE_HISTORY_COMMAND = 'slurmStatusBar.openFairshareHistory';

export const HISTORY_CLUSTERS = ['fir', 'ror', 'nibi', 'tril', 'nar'] as const;
export const FAIRSHARE_METRICS = ['cpu', 'gpu'] as const;
export type HistoryCluster = typeof HISTORY_CLUSTERS[number];
export type FairshareMetric = typeof FAIRSHARE_METRICS[number];
export type HistorySeriesKey = `${HistoryCluster}_${FairshareMetric}`;

export const HISTORY_SERIES: HistorySeriesKey[] = [
    'fir_cpu', 'fir_gpu',
    'ror_cpu', 'ror_gpu',
    'nibi_cpu', 'nibi_gpu',
    'tril_cpu', 'tril_gpu',
    'nar_cpu', 'nar_gpu',
];

export const STATUS_LABELS = ['Fir', 'Ror', 'Nibi', 'Tril', 'Nar'];
export const SPARKLINE_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
export const MAX_TOOLTIP_HISTORY_POINTS = 24;

export const CLUSTER_DISPLAY: Record<HistoryCluster, string> = {
    fir: 'Fir',
    ror: 'Ror',
    nibi: 'Nibi',
    tril: 'Tril',
    nar: 'Narval',
};

export const SERIES_DISPLAY: Record<HistorySeriesKey, string> = {
    fir_cpu: 'Fir CPU',
    fir_gpu: 'Fir GPU',
    ror_cpu: 'Ror CPU',
    ror_gpu: 'Ror GPU',
    nibi_cpu: 'Nibi CPU',
    nibi_gpu: 'Nibi GPU',
    tril_cpu: 'Trillium CPU',
    tril_gpu: 'Trillium GPU',
    nar_cpu: 'Narval CPU',
    nar_gpu: 'Narval GPU',
};

export const SERIES_COLORS: Record<HistorySeriesKey, string> = {
    fir_cpu: '#ffb3b3',
    fir_gpu: '#ff6b6b',
    ror_cpu: '#9bd0ff',
    ror_gpu: '#4dabf7',
    nibi_cpu: '#9be7a7',
    nibi_gpu: '#51cf66',
    tril_cpu: '#ffd08a',
    tril_gpu: '#f59f00',
    nar_cpu: '#d6b6ff',
    nar_gpu: '#9b5de5',
};

export const SERIES_DASHARRAY: Record<HistorySeriesKey, string> = {
    fir_cpu: '8 5',
    fir_gpu: '',
    ror_cpu: '8 5',
    ror_gpu: '',
    nibi_cpu: '8 5',
    nibi_gpu: '',
    tril_cpu: '8 5',
    tril_gpu: '',
    nar_cpu: '8 5',
    nar_gpu: '',
};
