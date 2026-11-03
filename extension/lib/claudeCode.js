// Claude Code adapter: reads ~/.claude/sessions/<pid>.json.
// This format appears to be internal to Claude Code and can change (see docs/SPEC.md).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    compareSessions,
    isSameLiveProcess,
    normalizeClaudeSession,
    parseProcStat,
} from './model.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

const BATCH_SIZE = 50;
const MAX_PROCESS_DEPTH = 32;
const decoder = new TextDecoder();

export function claudeDirectory() {
    return GLib.getenv('CLAUDE_CONFIG_DIR') ||
        GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
}

export function sessionsDirectory() {
    return GLib.build_filenamev([claudeDirectory(), 'sessions']);
}

export async function readText(path, cancellable) {
    const file = Gio.File.new_for_path(path);
    const [bytes] = await file.load_contents_async(cancellable);
    return decoder.decode(bytes);
}

// Lists the names in a directory; a missing directory gives an empty list.
export async function listNames(directory, suffix, cancellable) {
    const dir = Gio.File.new_for_path(directory);
    let enumerator;
    try {
        enumerator = await dir.enumerate_children_async(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable);
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return [];
        throw e;
    }

    const names = [];
    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const infos = await enumerator.next_files_async(
                BATCH_SIZE, GLib.PRIORITY_DEFAULT, cancellable);
            if (infos.length === 0)
                break;
            names.push(...infos
                .map(info => info.get_name())
                .filter(name => name.endsWith(suffix)));
        }
    } finally {
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }
    return names;
}

export function rethrowIfCancelled(e) {
    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        throw e;
}

async function isAlive(session, cancellable) {
    try {
        const text = await readText(`/proc/${session.pid}/stat`, cancellable);
        return isSameLiveProcess(parseProcStat(text), session.procStart);
    } catch (e) {
        rethrowIfCancelled(e);
        return false; // The process has gone in the meantime.
    }
}

async function loadSession(directory, name, previous, cancellable) {
    let session = previous.get(name) ?? null;
    try {
        const text = await readText(GLib.build_filenamev([directory, name]), cancellable);
        session = normalizeClaudeSession(JSON.parse(text));
        // Valid JSON without the expected fields: the format may have changed.
        if (!session)
            return {name, session: null, rejected: true};
    } catch (e) {
        rethrowIfCancelled(e);
        // File being written or deleted: keep the last known value so an icon does not
        // flicker. isAlive decides next.
    }
    if (!session || !(await isAlive(session, cancellable)))
        return null;
    return {name, session};
}

// Walks up the process tree from a PID, nearest first.
export async function processAncestors(pid, cancellable = null) {
    const ancestors = [];
    let current = pid;
    for (let depth = 0; current > 1 && depth < MAX_PROCESS_DEPTH; depth++) {
        ancestors.push(current);
        try {
            // eslint-disable-next-line no-await-in-loop
            const stat = parseProcStat(await readText(`/proc/${current}/stat`, cancellable));
            current = stat?.parent ?? 0;
        } catch (e) {
            rethrowIfCancelled(e);
            break;
        }
    }
    return ancestors;
}

// Returns the sorted live sessions, the cache to pass to the next scan, and how
// many files were rejected.
export async function scanSessions(directory, previous, cancellable = null) {
    // The .json filter notably excludes the .key files in this directory, which the
    // extension must never open.
    const names = await listNames(directory, '.json', cancellable);
    const loaded = await Promise.all(
        names.map(name => loadSession(directory, name, previous, cancellable)));
    const entries = loaded.filter(entry => entry?.session);

    return {
        rejected: loaded.filter(entry => entry?.rejected).length,
        sessions: entries.map(entry => entry.session).sort(compareSessions),
        cache: new Map(entries.map(entry => [entry.name, entry.session])),
    };
}
