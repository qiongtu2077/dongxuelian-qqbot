type TransactionStage = 'recover' | 'prepared' | 'replacing' | 'refreshing' | 'verifying' | 'committed' | 'rolling_back' | 'cleanup';
interface TransactionTarget {
    name: string;
    filePath: string;
    content: Buffer;
    mode?: number;
}
interface TransactionHooks {
    beforeStage?(stage: TransactionStage, targetName?: string): void;
}
interface TransactionOptions {
    dataDir: string;
    targets: TransactionTarget[];
    refresh(): void;
    verify(): void;
    hooks?: TransactionHooks;
}
interface TransactionResult {
    id: string;
    cleanupWarning: boolean;
}
declare class ConfigTransactionError extends Error {
    code: string;
    transactionId: string;
    stage: TransactionStage;
    files: string[];
    constructor(message: string, code: string, transactionId: string, stage: TransactionStage, files?: string[]);
}
declare function recoverPendingConfigTransactions(dataDir: string, hooks?: TransactionHooks): void;
declare function executeConfigTransaction(options: TransactionOptions): TransactionResult;
declare const _default: {
    ConfigTransactionError: typeof ConfigTransactionError;
    executeConfigTransaction: typeof executeConfigTransaction;
    recoverPendingConfigTransactions: typeof recoverPendingConfigTransactions;
};
export = _default;
