declare function getLinuxNapcatQQExecutable(): any;
declare function findNapcatMarkers(root: any): {
    markers: any[];
    archives: any[];
};
declare function rankNapcatEntry(filePath: any): 1 | 0 | 5 | 2 | 4 | 3 | 6 | 20;
declare function sortNapcatEntries(markers?: any[]): any[];
declare function findNapcatQQExecutable(root: any): any;
declare function entryRequiresBundledQQ(entry: any): boolean;
declare function inspectNapcatCandidate(candidate: any): {
    found: boolean;
    status: string;
    entry: any;
    reason: string;
    path: any;
    exists: boolean;
} | {
    status: string;
    entry: any;
    reason: string;
    markers: any[];
    path: any;
    exists: boolean;
    found: boolean;
} | {
    found: boolean;
    status: string;
    entry: any;
    reason: string;
    markers: any[];
    qqExecutable: any;
    path: any;
    exists: boolean;
} | {
    status: string;
    reason: string;
    archives: any[];
    path: any;
    exists: boolean;
    found: boolean;
} | {
    status: string;
    reason: any;
    path: any;
    exists: boolean;
    found: boolean;
};
declare function detectNapcatInstallation(): {
    found: boolean;
    status: string;
    path: any;
    expectedPath: any;
    entry: any;
    reason: any;
    candidates: any;
};
declare function getNapcatStartEntry(): {
    detected: {
        found: boolean;
        status: string;
        path: any;
        expectedPath: any;
        entry: any;
        reason: any;
        candidates: any;
    };
    entry: any;
};
declare function listNapcatConfigDirs(): any;
declare function readNapcatWebuiPortFromConfigFiles(): number;
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
