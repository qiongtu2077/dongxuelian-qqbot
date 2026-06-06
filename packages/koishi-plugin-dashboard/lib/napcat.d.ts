type NapcatMarkerType = 'installer' | 'entry' | 'config' | 'package';
type NapcatInspectionStatus = 'missing' | 'installed' | 'partial' | 'unknown' | 'unsupported';
interface NapcatMarker {
    path: string;
    rel: string;
    type: NapcatMarkerType;
}
interface NapcatArchive {
    path: string;
    rel: string;
}
interface NapcatMarkersResult {
    markers: NapcatMarker[];
    archives: NapcatArchive[];
}
interface NapcatInspection {
    path: string;
    exists: boolean;
    found: boolean;
    status: NapcatInspectionStatus;
    reason?: string;
    entry?: string;
    markers?: NapcatMarker[];
    archives?: NapcatArchive[];
    qqExecutable?: string;
}
interface NapcatCandidateSummary {
    path: string;
    exists: boolean;
    status: NapcatInspectionStatus;
    reason?: string;
    entry: string;
    qqExecutable: string;
}
interface NapcatDetection {
    found: boolean;
    status: 'unsupported' | 'installed' | 'partial' | 'missing';
    path: string;
    expectedPath: string;
    entry: string;
    reason: string;
    candidates: NapcatCandidateSummary[];
}
declare function getLinuxNapcatQQExecutable(): string;
declare function findNapcatMarkers(root: string): NapcatMarkersResult;
declare function rankNapcatEntry(filePath: string | null | undefined): number;
declare function sortNapcatEntries(markers?: NapcatMarker[]): NapcatMarker[];
declare function findNapcatQQExecutable(root: string): string;
declare function entryRequiresBundledQQ(entry: NapcatMarker | string | null | undefined): boolean;
declare function inspectNapcatCandidate(candidate: string): NapcatInspection;
declare function detectNapcatInstallation(): NapcatDetection;
declare function getNapcatStartEntry(): {
    detected: NapcatDetection;
    entry: string;
};
declare function listNapcatConfigDirs(): string[];
declare function readNapcatWebuiPortFromConfigFiles(): number | null;
declare function resolveNapcatWebuiListenPort(): number;
declare function resolveNapcatOnebotListenPort(): number;
interface NapcatTokenFn {
    (): string;
    _cached?: string;
    _mtimeMs?: number;
    _cachePath?: string;
}
declare const _default: {
    getLinuxNapcatQQExecutable: typeof getLinuxNapcatQQExecutable;
    findNapcatMarkers: typeof findNapcatMarkers;
    rankNapcatEntry: typeof rankNapcatEntry;
    sortNapcatEntries: typeof sortNapcatEntries;
    findNapcatQQExecutable: typeof findNapcatQQExecutable;
    entryRequiresBundledQQ: typeof entryRequiresBundledQQ;
    inspectNapcatCandidate: typeof inspectNapcatCandidate;
    detectNapcatInstallation: typeof detectNapcatInstallation;
    getNapcatStartEntry: typeof getNapcatStartEntry;
    listNapcatConfigDirs: typeof listNapcatConfigDirs;
    readNapcatWebuiPortFromConfigFiles: typeof readNapcatWebuiPortFromConfigFiles;
    resolveNapcatWebuiListenPort: typeof resolveNapcatWebuiListenPort;
    resolveNapcatOnebotListenPort: typeof resolveNapcatOnebotListenPort;
    getNapcatToken: NapcatTokenFn;
};
export = _default;
