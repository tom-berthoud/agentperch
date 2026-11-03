// Lit ~/.claude/projects/ : sous-agents et tokens de chaque session. Ces fichiers
// contiennent les conversations : seuls des nombres, le modèle et le type et la
// description des sous-agents en sortent. Format interne, voir docs/SPEC.md.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {listNames, readText, rethrowIfCancelled} from './claudeCode.js';
import {UsageAccumulator, isSubagentRunning, projectDirName} from './model.js';

Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.InputStream.prototype, 'skip_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

// Morceaux courts, en priorité basse : un transcript peut peser plusieurs Mo, et
// rendre la main entre deux lectures garde la barre fluide.
const CHUNK_BYTES = 128 * 1024;
const AGENTS_MIN_INTERVAL_MS = 2000;
const MISSING_DIR_RETRY_MS = 30_000;
const AGENT_SETTLE_MS = 2000;
const META_SUFFIX = '.meta.json';

export function projectsDirectory() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects']);
}

async function queryInfo(path, attributes, cancellable) {
    try {
        return await Gio.File.new_for_path(path).query_info_async(
            attributes, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable);
    } catch (e) {
        rethrowIfCancelled(e);
        return null;
    }
}

// Lecture incrémentale : seuls les octets ajoutés depuis la dernière fois sont lus.
class UsageFile {
    constructor(path, options) {
        this._path = path;
        this._options = options;
        this._accumulator = new UsageAccumulator(options);
        this._offset = 0;
        this._pending = null;
    }

    update(cancellable) {
        this._pending ??= this._read(cancellable).finally(() => {
            this._pending = null;
        });
        return this._pending;
    }

    totals() {
        return this._accumulator.totals();
    }

    async _read(cancellable) {
        const info = await queryInfo(this._path, 'standard::size', cancellable);
        if (!info)
            return;

        const size = info.get_size();
        if (size < this._offset) { // Fichier réécrit : on repart de zéro.
            this._accumulator = new UsageAccumulator(this._options);
            this._offset = 0;
        }
        if (size === this._offset)
            return;

        const stream = await Gio.File.new_for_path(this._path)
            .read_async(GLib.PRIORITY_LOW, cancellable);
        try {
            let remaining = this._offset;
            while (remaining > 0) {
                // eslint-disable-next-line no-await-in-loop
                const skipped = await stream.skip_async(remaining, GLib.PRIORITY_LOW, cancellable);
                if (skipped <= 0)
                    return;
                remaining -= skipped;
            }
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const bytes = await stream.read_bytes_async(
                    CHUNK_BYTES, GLib.PRIORITY_LOW, cancellable);
                const data = bytes.toArray();
                if (data.length === 0)
                    break;
                this._accumulator.feed(data);
                this._offset += data.length;
            }
        } finally {
            await stream.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
        }
    }
}

export class SessionFiles {
    constructor(root, cancellable) {
        this._root = root;
        this._cancellable = cancellable;
        this._entries = new Map();
    }

    _entry(session) {
        let entry = this._entries.get(session.sessionId);
        if (!entry) {
            entry = {dir: null, dirPending: null, dirCheckedAt: -Infinity, agents: new Map(),
                agentsAt: -Infinity, agentsPending: null, main: null};
            this._entries.set(session.sessionId, entry);
        }
        return entry;
    }

    // Oublie les sessions fermées.
    retain(sessions) {
        const live = new Set(sessions.map(session => session.sessionId));
        for (const id of this._entries.keys()) {
            if (!live.has(id))
                this._entries.delete(id);
        }
    }

    // Partagé : le badge et le menu peuvent demander le dossier en même temps.
    _projectDir(session, entry) {
        if (entry.dir)
            return Promise.resolve(entry.dir);
        entry.dirPending ??= this._findProjectDir(session, entry).finally(() => {
            entry.dirPending = null;
        });
        return entry.dirPending;
    }

    async _findProjectDir(session, entry) {
        const hasTranscript = async dir => await queryInfo(
            `${dir}/${session.sessionId}.jsonl`, 'standard::type', this._cancellable) !== null;

        // Le transcript n'existe pas avant le premier message : ce test léger est
        // refait à chaque fois.
        if (session.cwd) {
            const dir = `${this._root}/${projectDirName(session.cwd)}`;
            if (await hasTranscript(dir)) {
                entry.dir = dir;
                return dir;
            }
        }

        // Le cwd courant peut différer de celui du lancement : repli sur une
        // recherche dans tous les projets, plus rare.
        const now = GLib.get_monotonic_time() / 1000;
        if (now - entry.dirCheckedAt < MISSING_DIR_RETRY_MS)
            return null;
        entry.dirCheckedAt = now;

        for (const name of await listNames(this._root, '', this._cancellable)) {
            const dir = `${this._root}/${name}`;
            // eslint-disable-next-line no-await-in-loop
            if (await hasTranscript(dir)) {
                entry.dir = dir;
                return dir;
            }
        }
        return null;
    }

    async _refreshAgent(agents, directory, name, session) {
        const id = name.slice(0, -META_SUFFIX.length);
        const known = agents.get(id);
        if (known?.finished)
            return;

        let meta = null;
        try {
            meta = JSON.parse(await readText(`${directory}/${name}`, this._cancellable));
        } catch (e) {
            rethrowIfCancelled(e);
            if (!known) // Fichier en cours d'écriture : il sera relu au prochain passage.
                return;
        }

        const transcript = `${directory}/${id}.jsonl`;
        const info = await queryInfo(transcript, 'time::modified', this._cancellable);
        // La précision est à la seconde : on prend la fin de cette seconde.
        const mtime = info ? (info.get_attribute_uint64('time::modified') + 1) * 1000 : 0;

        const agent = known ?? {
            id,
            usage: new UsageFile(transcript, {includeSidechain: true}),
            usageComplete: false,
        };
        if (meta) {
            agent.type = typeof meta.agentType === 'string' ? meta.agentType : null;
            agent.description = typeof meta.description === 'string' ? meta.description : null;
            agent.finished = meta.finished === true;
            agent.running = isSubagentRunning(meta, mtime, session.startedAt);
        }
        agent.mtime = mtime;
        agents.set(id, agent);
    }

    async _refreshAgents(session, entry) {
        const dir = await this._projectDir(session, entry);
        if (!dir)
            return;
        const directory = `${dir}/${session.sessionId}/subagents`;
        const names = await listNames(directory, META_SUFFIX, this._cancellable);
        await Promise.all(names.map(
            name => this._refreshAgent(entry.agents, directory, name, session)));
    }

    // Partagé entre le badge et le menu : limité à un passage toutes les 2 s.
    async _agents(session) {
        const entry = this._entry(session);
        const now = GLib.get_monotonic_time() / 1000;
        if (!entry.agentsPending && now - entry.agentsAt >= AGENTS_MIN_INTERVAL_MS) {
            entry.agentsAt = now;
            entry.agentsPending = this._refreshAgents(session, entry).finally(() => {
                entry.agentsPending = null;
            });
        }
        await entry.agentsPending;
        return entry.agents;
    }

    async runningAgentCount(session) {
        const agents = await this._agents(session);
        return Array.from(agents.values()).filter(agent => agent.running).length;
    }

    async _agentDetails(session, withUsage) {
        const agents = Array.from((await this._agents(session)).values());
        for (const agent of agents) {
            if (!withUsage || agent.usageComplete)
                continue;
            // Le transcript peut encore recevoir des lignes juste après `finished` :
            // cette lecture n'est la dernière que si le sous-agent a fini depuis un moment.
            const settled = agent.finished === true &&
                Date.now() - agent.mtime > AGENT_SETTLE_MS;
            // Séquentiel : une session peut avoir des dizaines de transcripts.
            // eslint-disable-next-line no-await-in-loop
            await agent.usage.update(this._cancellable);
            agent.usageComplete = settled;
        }
        return agents
            .sort((a, b) => Number(b.running) - Number(a.running) || b.mtime - a.mtime)
            .map(agent => ({
                type: agent.type,
                description: agent.description,
                finished: agent.finished,
                running: agent.running,
                usage: withUsage ? agent.usage.totals() : null,
            }));
    }

    async _usage(session) {
        const entry = this._entry(session);
        const dir = await this._projectDir(session, entry);
        if (!dir)
            return null;
        entry.main ??= new UsageFile(`${dir}/${session.sessionId}.jsonl`, {});
        await entry.main.update(this._cancellable);
        return entry.main.totals();
    }

    async details(session, {usage, subagents}) {
        return {
            usage: usage ? await this._usage(session) : null,
            agents: subagents ? await this._agentDetails(session, usage) : null,
        };
    }
}
