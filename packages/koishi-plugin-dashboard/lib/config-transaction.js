'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
class ConfigTransactionError extends Error {
    // Carries only non-sensitive transaction metadata to the HTTP layer.
    constructor(message, code, transactionId, stage, files = []) {
        super(message);
        this.name = 'ConfigTransactionError';
        this.code = code;
        this.transactionId = transactionId;
        this.stage = stage;
        this.files = files;
    }
}
const TRANSACTION_DIR_NAME = '.dashboard-api-config-transactions';
const TRANSACTION_LOCK_NAME = '.dashboard-api-config-transaction.lock';
// --- Path and lock guards ---
// Confirms that every transaction artifact remains inside the configured data directory.
function assertInsideDataDir(dataDir, targetPath) {
    const root = path.resolve(dataDir);
    const target = path.resolve(targetPath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('事务目标必须是数据目录内的文件');
    }
}
// Reports whether a recorded lock owner still exists.
function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
        return code === 'EPERM';
    }
}
// Acquires the cross-process transaction lock and removes only a proven stale lock.
function acquireTransactionLock(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const lockPath = path.join(dataDir, TRANSACTION_LOCK_NAME);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = fs.openSync(lockPath, 'wx', 0o600);
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
            fs.fsyncSync(fd);
            return { path: lockPath, fd };
        }
        catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
            if (code !== 'EEXIST')
                throw error;
            let ownerPid = 0;
            try {
                ownerPid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid || 0);
            }
            catch {
                ownerPid = 0;
            }
            if (isProcessAlive(ownerPid))
                throw new ConfigTransactionError('另一个 API 配置保存正在执行', 'API_CONFIG_BUSY', '', 'prepared');
            try {
                fs.unlinkSync(lockPath);
            }
            catch { /* the second open reports the definitive result */ }
        }
    }
    throw new ConfigTransactionError('无法取得 API 配置事务锁', 'API_CONFIG_BUSY', '', 'prepared');
}
// Releases only the lock acquired by this process invocation.
function releaseTransactionLock(lock) {
    try {
        fs.closeSync(lock.fd);
    }
    catch { /* best-effort descriptor cleanup */ }
    try {
        fs.unlinkSync(lock.path);
    }
    catch { /* the stale-lock check handles later cleanup */ }
}
// --- Journal and recovery ---
// Writes the current journal state durably without including configuration contents.
function writeJournal(journalPath, journal) {
    const fd = fs.openSync(journalPath, 'w', 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(journal, null, 2), 'utf8');
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}
// Restores every formal target from its snapshot in reverse replacement order.
function restoreJournal(journal, hooks) {
    hooks?.beforeStage?.('rolling_back');
    journal.state = 'rolling_back';
    for (const target of [...journal.targets].reverse()) {
        hooks?.beforeStage?.('rolling_back', target.name);
        if (fs.existsSync(target.filePath))
            fs.unlinkSync(target.filePath);
        if (target.existed) {
            if (!fs.existsSync(target.backupPath))
                throw new Error(`缺少 ${target.name} 的事务备份`);
            fs.copyFileSync(target.backupPath, target.filePath);
            fs.chmodSync(target.filePath, target.mode);
        }
        if (fs.existsSync(target.nextPath))
            fs.unlinkSync(target.nextPath);
    }
}
// Recovers every uncommitted journal left by a terminated process.
function recoverPendingTransactionsLocked(dataDir, hooks) {
    hooks?.beforeStage?.('recover');
    const root = path.join(dataDir, TRANSACTION_DIR_NAME);
    if (!fs.existsSync(root))
        return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const transactionDir = path.join(root, entry.name);
        const journalPath = path.join(transactionDir, 'journal.json');
        if (!fs.existsSync(journalPath))
            continue;
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        if (journal.state !== 'committed')
            restoreJournal(journal, hooks);
        fs.rmSync(transactionDir, { recursive: true, force: true });
    }
}
// Acquires the lock before exposing startup/next-run recovery to callers.
function recoverPendingConfigTransactions(dataDir, hooks) {
    const lock = acquireTransactionLock(dataDir);
    try {
        recoverPendingTransactionsLocked(dataDir, hooks);
    }
    finally {
        releaseTransactionLock(lock);
    }
}
// --- Transaction execution ---
// Writes and re-reads a same-directory next file before replacement begins.
function prepareNextFile(target, nextPath) {
    const fd = fs.openSync(nextPath, 'wx', target.mode ?? 0o600);
    try {
        fs.writeFileSync(fd, target.content);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    if (!fs.readFileSync(nextPath).equals(target.content))
        throw new Error(`无法校验 ${target.name} 临时文件`);
}
// Executes an all-or-restore file transaction and verifies runtime readback before commit.
function executeConfigTransaction(options) {
    const dataDir = path.resolve(options.dataDir);
    if (!options.targets.length)
        throw new Error('事务没有目标文件');
    for (const target of options.targets)
        assertInsideDataDir(dataDir, target.filePath);
    const lock = acquireTransactionLock(dataDir);
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
    const transactionRoot = path.join(dataDir, TRANSACTION_DIR_NAME);
    const transactionDir = path.join(transactionRoot, id);
    const journalPath = path.join(transactionDir, 'journal.json');
    let journal = null;
    let cleanupWarning = false;
    try {
        recoverPendingTransactionsLocked(dataDir, options.hooks);
        fs.mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
        const journalTargets = options.targets.map((target, index) => {
            const stat = fs.existsSync(target.filePath) ? fs.statSync(target.filePath) : null;
            const nextPath = `${target.filePath}.${id}.next`;
            const backupPath = path.join(transactionDir, `${index}-${target.name}.backup`);
            if (stat?.isFile()) {
                fs.writeFileSync(backupPath, fs.readFileSync(target.filePath), { mode: 0o600 });
                fs.chmodSync(backupPath, 0o600);
            }
            return { name: target.name, filePath: target.filePath, nextPath, backupPath, existed: !!stat?.isFile(), mode: stat?.mode ? stat.mode & 0o777 : (target.mode ?? 0o600) };
        });
        journal = { id, state: 'prepared', createdAt: Date.now(), targets: journalTargets };
        writeJournal(journalPath, journal);
        for (let index = 0; index < options.targets.length; index += 1) {
            options.hooks?.beforeStage?.('prepared', options.targets[index].name);
            prepareNextFile(options.targets[index], journal.targets[index].nextPath);
        }
        journal.state = 'replacing';
        writeJournal(journalPath, journal);
        for (const target of journal.targets) {
            options.hooks?.beforeStage?.('replacing', target.name);
            // Windows cannot rename over an existing file; the durable snapshot makes this gap recoverable.
            if (fs.existsSync(target.filePath))
                fs.unlinkSync(target.filePath);
            fs.renameSync(target.nextPath, target.filePath);
            fs.chmodSync(target.filePath, target.mode);
        }
        options.hooks?.beforeStage?.('refreshing');
        journal.state = 'refreshing';
        writeJournal(journalPath, journal);
        options.refresh();
        options.hooks?.beforeStage?.('verifying');
        journal.state = 'verifying';
        writeJournal(journalPath, journal);
        options.verify();
        options.hooks?.beforeStage?.('committed');
        journal.state = 'committed';
        writeJournal(journalPath, journal);
    }
    catch (error) {
        if (!journal) {
            try {
                if (fs.existsSync(transactionDir))
                    fs.rmSync(transactionDir, { recursive: true, force: true });
            }
            catch { /* preserve the original preparation error */ }
            throw error;
        }
        const failedStage = journal.state;
        try {
            journal.state = 'rolling_back';
            writeJournal(journalPath, journal);
            restoreJournal(journal, options.hooks);
            options.refresh();
        }
        catch {
            throw new ConfigTransactionError('API 配置自动恢复失败，需要人工检查', 'API_CONFIG_ROLLBACK_FAILED', id, 'rolling_back', journal.targets.map(item => path.basename(item.filePath)));
        }
        try {
            fs.rmSync(transactionDir, { recursive: true, force: true });
        }
        catch { /* preserve the transaction failure */ }
        throw new ConfigTransactionError(`API 配置未生效，旧配置已恢复（阶段：${failedStage}）`, 'API_CONFIG_TRANSACTION_FAILED', id, failedStage);
    }
    finally {
        try {
            options.hooks?.beforeStage?.('cleanup');
        }
        catch {
            cleanupWarning = true;
        }
        try {
            if (fs.existsSync(transactionDir) && journal?.state === 'committed')
                fs.rmSync(transactionDir, { recursive: true, force: true });
        }
        catch {
            cleanupWarning = true;
        }
        releaseTransactionLock(lock);
    }
    return { id, cleanupWarning };
}
module.exports = {
    ConfigTransactionError,
    executeConfigTransaction,
    recoverPendingConfigTransactions,
};
