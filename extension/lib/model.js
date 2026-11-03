// Pure logic with no GNOME Shell dependency: testable with `gjs -m`.

export const State = Object.freeze({
    WORKING: 'working',
    WAITING: 'waiting',
    BACKGROUND: 'background',
    DONE: 'done', // Finished since the user last looked at its menu.
    IDLE: 'idle',
    UNKNOWN: 'unknown',
});

// Values observed on Claude Code 2.1.317 (see docs/SPEC.md).
const CLAUDE_STATUS_TO_STATE = {
    busy: State.WORKING,
    waiting: State.WAITING,
    shell: State.BACKGROUND, // Turn finished, a command is still running in the background.
    idle: State.IDLE,
};

const STATE_TEXT = {
    [State.WORKING]: 'Working',
    [State.WAITING]: 'Waiting for you',
    [State.BACKGROUND]: 'Background task running',
    [State.DONE]: 'Finished',
    [State.IDLE]: 'Idle',
    [State.UNKNOWN]: 'Unknown state',
};

const WAITING_REASON_TEXT = {
    'permission prompt': 'Asking for permission',
    'input needed': 'Asking a question',
};

// From most to least urgent: this is the state the single icon shows.
const STATE_PRIORITY = [
    State.WAITING,
    State.DONE,
    State.WORKING,
    State.BACKGROUND,
    State.UNKNOWN,
    State.IDLE,
];

const ACTIVE_STATES = new Set([State.WORKING, State.WAITING, State.BACKGROUND]);
const ATTENTION_STATES = new Set([State.WAITING, State.DONE]);

// Copies only the useful fields: the source file also holds information (messaging
// socket, etc.) that the UI has no reason to keep.
export function normalizeClaudeSession(raw) {
    if (!Number.isInteger(raw?.pid) || raw.pid <= 0 || typeof raw.sessionId !== 'string')
        return null;

    const rawStatus = typeof raw.status === 'string' ? raw.status : null;
    return {
        source: 'claude-code',
        key: `${raw.pid}:${raw.procStart ?? ''}`,
        pid: raw.pid,
        procStart: raw.procStart === undefined ? null : String(raw.procStart),
        sessionId: raw.sessionId,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
        name: typeof raw.name === 'string' ? raw.name : null,
        kind: typeof raw.kind === 'string' ? raw.kind : null,
        version: typeof raw.version === 'string' ? raw.version : null,
        rawStatus,
        waitingFor: typeof raw.waitingFor === 'string' ? raw.waitingFor : null,
        state: CLAUDE_STATUS_TO_STATE[rawStatus] ?? State.UNKNOWN,
        startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : 0,
        statusSince: Number.isFinite(raw.statusUpdatedAt) ? raw.statusUpdatedAt : null,
    };
}

// Format of /proc/<pid>/stat: "pid (comm) state ... starttime ...".
// comm can contain spaces and parentheses, so split at the last ")". Field 3
// (state) becomes index 0, field 22 (starttime) index 19.
export function parseProcStat(text) {
    const end = text.lastIndexOf(')');
    if (end < 0)
        return null;

    const fields = text.slice(end + 1).trim().split(/\s+/);
    if (fields.length < 20)
        return null;

    return {state: fields[0], parent: Number(fields[1]), startTime: fields[19]};
}

// Comparing starttime protects against a PID being reused by another process after
// a Claude Code crash.
export function isSameLiveProcess(stat, procStart) {
    if (!stat || stat.state === 'Z' || stat.state === 'X')
        return false;
    return procStart === null || stat.startTime === procStart;
}

export function compareSessions(a, b) {
    return a.startedAt - b.startedAt || a.pid - b.pid;
}

export function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60)
        return `${seconds} s`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes} min`;

    const hours = Math.floor(minutes / 60);
    return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
}

export function displayName(session) {
    if (session.name)
        return session.name;
    const base = session.cwd?.split('/').filter(Boolean).pop();
    return base || `pid ${session.pid}`;
}

export function shortLabel(session, maxChars = 14) {
    const chars = Array.from(displayName(session));
    return chars.length <= maxChars
        ? chars.join('')
        : `${chars.slice(0, maxChars - 1).join('')}…`;
}

export function prettyPath(path, home) {
    if (!path)
        return '—';
    if (path === home)
        return '~';
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function stateText(session) {
    if (session.state === State.UNKNOWN)
        return `${STATE_TEXT[State.UNKNOWN]} (${session.rawStatus ?? 'missing'})`;
    if (session.state === State.WAITING && session.waitingFor)
        return WAITING_REASON_TEXT[session.waitingFor] ?? `${STATE_TEXT[State.WAITING]} (${session.waitingFor})`;
    return STATE_TEXT[session.state];
}

// Turns `idle` into `done` for a session that finished since its menu was last
// closed. It cannot know whether the user saw the terminal. Not persisted: a restart
// of the Shell forgets it.
export class AttentionTracker {
    constructor() {
        this._previous = new Map();
        this._unseen = new Set();
    }

    apply(sessions) {
        const previous = new Map();
        const result = sessions.map(session => {
            const before = this._previous.get(session.key);
            previous.set(session.key, session.state);

            if (session.state !== State.IDLE) {
                this._unseen.delete(session.key);
                return session;
            }
            if (ACTIVE_STATES.has(before))
                this._unseen.add(session.key);
            return this._unseen.has(session.key) ? {...session, state: State.DONE} : session;
        });

        this._previous = previous;
        for (const key of this._unseen) {
            if (!previous.has(key))
                this._unseen.delete(key);
        }
        return result;
    }

    markSeen(key) {
        this._unseen.delete(key);
    }
}

export function compareByUrgency(a, b) {
    return STATE_PRIORITY.indexOf(a.state) - STATE_PRIORITY.indexOf(b.state) ||
        compareSessions(a, b);
}

// Label next to a session's icon. names: always | attention | never.
export function sessionLabel(session, runningAgents, names) {
    const showName = names === 'always' ||
        (names === 'attention' && ATTENTION_STATES.has(session.state));
    return [showName ? shortLabel(session) : '', runningAgents > 0 ? `+${runningAgents}` : '']
        .filter(Boolean).join(' ');
}

// Label of the single icon: a count only means something with several sessions.
export function summaryLabel(sessions, runningAgents) {
    const waiting = sessions.filter(session => session.state === State.WAITING).length;
    let count = '';
    if (sessions.length > 1)
        count = waiting > 0 ? `${waiting} waiting / ${sessions.length}` : String(sessions.length);
    return [count, runningAgents > 0 ? `+${runningAgents}` : ''].filter(Boolean).join(' ');
}

// Finds the window holding a session from its process ancestors, nearest first.
// Terminals with a single server process own all their windows under one PID, so
// among those the title decides, then the most recently used. The tab stays unknown.
export function chooseWindow(windows, ancestors, name) {
    for (const pid of ancestors) {
        const owned = windows.filter(window => window.pid === pid);
        if (owned.length === 0)
            continue;
        const byTitle = owned.filter(window => name && window.title?.includes(name));
        return (byTitle.length > 0 ? byTitle : owned)
            .reduce((best, window) => (window.userTime > best.userTime ? window : best));
    }
    return null;
}

export function aggregateState(sessions) {
    const states = new Set(sessions.map(session => session.state));
    return STATE_PRIORITY.find(state => states.has(state)) ?? State.IDLE;
}

// Directory name in ~/.claude/projects: each non-alphanumeric character of the path
// becomes a dash. This rule comes from observation, hence the fallback search by
// sessionId in transcripts.js.
export function projectDirName(cwd) {
    return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// `finished` stays absent on old subagent files and on those stopped by the user
// (`stoppedByUser`): only a transcript modified since the process started can mean a
// running subagent. Without both dates nothing can be claimed, and no badge is better
// than a wrong one.
export function isSubagentRunning(meta, transcriptMtimeMs, sessionStartedAt) {
    if (meta?.finished === true || meta?.stoppedByUser === true)
        return false;
    return transcriptMtimeMs > 0 && sessionStartedAt > 0 &&
        transcriptMtimeMs >= sessionStartedAt;
}

const USAGE_MARKER = '"usage"';
const NEWLINE = 10;

// Adds up the tokens of a .jsonl transcript read in chunks. Keeps only numbers and
// the model name, never message content.
export class UsageAccumulator {
    constructor({includeSidechain = false} = {}) {
        this._includeSidechain = includeSidechain;
        this._decoder = new TextDecoder();
        this._messages = new Map();
        this._rest = null;
        this._last = null;
        this._model = null;
    }

    feed(bytes) {
        let data = bytes;
        if (this._rest) {
            data = new Uint8Array(this._rest.length + bytes.length);
            data.set(this._rest);
            data.set(bytes, this._rest.length);
            this._rest = null;
        }

        // Split on bytes: a chunk can cut a UTF-8 character.
        let start = 0;
        for (;;) {
            const end = data.indexOf(NEWLINE, start);
            if (end < 0)
                break;
            this._consumeLine(data.subarray(start, end));
            start = end + 1;
        }
        if (start < data.length)
            this._rest = data.slice(start);
    }

    _consumeLine(bytes) {
        const line = this._decoder.decode(bytes);
        if (!line.includes(USAGE_MARKER))
            return;

        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            return;
        }

        const message = entry?.message;
        const usage = message?.usage;
        if (entry?.type !== 'assistant' || !usage || typeof message.id !== 'string')
            return;
        if (entry.isSidechain && !this._includeSidechain)
            return;
        // Synthetic messages (<synthetic>) reflect no real call.
        if (typeof message.model !== 'string' || message.model.startsWith('<'))
            return;

        // The same message.id appears on several lines with the same usage.
        const counts = {
            input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            cacheRead: usage.cache_read_input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
        };
        this._messages.set(message.id, counts);
        this._last = counts;
        this._model = message.model;
    }

    totals() {
        const totals = {input: 0, cacheRead: 0, output: 0};
        for (const counts of this._messages.values()) {
            totals.input += counts.input;
            totals.cacheRead += counts.cacheRead;
            totals.output += counts.output;
        }
        return {
            ...totals,
            model: this._model,
            context: this._last ? this._last.input + this._last.cacheRead : 0,
        };
    }
}

export function formatTokens(count) {
    if (count < 1000)
        return String(count);
    if (count < 1_000_000)
        return `${Math.round(count / 1000)}k`;
    return `${(count / 1_000_000).toFixed(1)}M`;
}

function truncate(text, maxChars) {
    const chars = Array.from(text);
    return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join('')}…`;
}

const MAX_INACTIVE_AGENTS_SHOWN = 5;
const MAX_DESCRIPTION_CHARS = 40;

function agentLine(agent) {
    const mark = agent.running ? '▶' : agent.finished ? '✓' : '–';
    const description = agent.description
        ? ` — ${truncate(agent.description, MAX_DESCRIPTION_CHARS)}`
        : '';
    const tokens = agent.usage
        ? ` · ${formatTokens(agent.usage.input + agent.usage.output)}`
        : '';
    return `${mark} ${agent.type ?? 'agent'}${description}${tokens}`;
}

// Menu detail lines. details: {usage: totals|null, agents: [...]|null}.
export function detailLines(details) {
    const lines = [];

    const usage = details.usage;
    if (usage?.model) {
        lines.push(`Model: ${usage.model}`);
        lines.push(`Current context: ${formatTokens(usage.context)} tokens`);
        lines.push(`Total: ${formatTokens(usage.input)} in · ` +
            `${formatTokens(usage.output)} out · ` +
            `${formatTokens(usage.cacheRead)} cache read`);
    }

    const agents = details.agents;
    if (agents?.length) {
        const running = agents.filter(agent => agent.running);
        const inactive = agents.filter(agent => !agent.running);
        const shown = inactive.slice(0, MAX_INACTIVE_AGENTS_SHOWN);
        lines.push(`Subagents: ${running.length} running of ${agents.length}`);
        lines.push(...running.map(agentLine), ...shown.map(agentLine));
        if (inactive.length > shown.length)
            lines.push(`+ ${inactive.length - shown.length} more`);
    }
    return lines;
}
