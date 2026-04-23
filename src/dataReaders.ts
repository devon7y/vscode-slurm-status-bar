import * as fs from 'fs';
import {
    FAIRSHARE_HISTORY_PATH,
    JOB_HISTORY_PATH,
    JOB_SNAPSHOT_HISTORY_PATH,
    NODE_HISTORY_PATH,
} from './constants';
import {
    parseHistoryCsv,
    parseJobHistoryCsv,
    parseJobSnapshotCsv,
} from './csv';
import type {
    HistoryRow,
    JobHistoryData,
    JobSnapshotRow,
} from './types';

async function readCsv<T>(
    filePath: string,
    parser: (content: string) => T,
    fallback: T,
    context: string,
): Promise<T> {
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        return parser(content);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error(`Error reading ${context}:`, error);
        }
        return fallback;
    }
}

export function readHistoryRows(): Promise<HistoryRow[]> {
    return readCsv(FAIRSHARE_HISTORY_PATH, parseHistoryCsv, [], 'fairshare history');
}

export function readJobHistory(): Promise<JobHistoryData> {
    return readCsv(
        JOB_HISTORY_PATH,
        parseJobHistoryCsv,
        { metricKeys: [], rows: [] },
        'job history',
    );
}

export function readJobSnapshots(): Promise<JobSnapshotRow[]> {
    return readCsv(JOB_SNAPSHOT_HISTORY_PATH, parseJobSnapshotCsv, [], 'job snapshot history');
}

export function readNodeHistory(): Promise<JobHistoryData> {
    return readCsv(
        NODE_HISTORY_PATH,
        parseJobHistoryCsv,
        { metricKeys: [], rows: [] },
        'node history',
    );
}
