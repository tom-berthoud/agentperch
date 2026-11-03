import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {processAncestors, scanSessions, sessionsDirectory} from './lib/claudeCode.js';
import {
    AttentionTracker,
    State,
    aggregateState,
    chooseWindow,
    compareByUrgency,
    detailLines,
    displayName,
    formatDuration,
    prettyPath,
    sessionLabel,
    stateText,
    summaryLabel,
} from './lib/model.js';
import {WaitingNotifier} from './lib/notifier.js';
import {SessionFiles, projectsDirectory} from './lib/transcripts.js';

// A crash produces no event in the directory: this periodic scan is what removes
// dead sessions.
const RESCAN_INTERVAL_S = 5;
const DEBOUNCE_MS = 150;
const SUMMARY_ROLE = 'agentperch-summary';

// The icon changes shape as well as color, so it stays readable without telling
// colors apart.
const STATE_ICON = {
    [State.WORKING]: 'content-loading-symbolic',
    [State.WAITING]: 'dialog-warning-symbolic',
    [State.BACKGROUND]: 'system-run-symbolic',
    [State.DONE]: 'mail-unread-symbolic',
    [State.IDLE]: 'object-select-symbolic',
    [State.UNKNOWN]: 'dialog-question-symbolic',
};

// The detail lines of a session, in a menu or a submenu.
class SessionDetailsView {
    constructor(menu, onGoToTerminal) {
        const addInfoItem = () => {
            const item = new PopupMenu.PopupMenuItem('', {reactive: false});
            menu.addMenuItem(item);
            return item;
        };
        this._titleItem = addInfoItem();
        this._stateItem = addInfoItem();
        this._pathItem = addInfoItem();
        this._ageItem = addInfoItem();
        this._metaItem = addInfoItem();

        const goToItem = new PopupMenu.PopupImageMenuItem(
            'Go to terminal', 'utilities-terminal-symbolic');
        goToItem.connect('activate', () => onGoToTerminal(this._session));
        menu.addMenuItem(goToItem);

        this._detailSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._detailSection);
        this._detailText = '';
    }

    update(session) {
        this._session = session;
        const now = Date.now();
        const since = session.statusSince === null
            ? ''
            : ` for ${formatDuration(now - session.statusSince)}`;

        this._titleItem.label.text = displayName(session);
        this._stateItem.label.text = `${stateText(session)}${since}`;
        this._pathItem.label.text = prettyPath(session.cwd, GLib.get_home_dir());
        this._ageItem.label.text = session.startedAt
            ? `Session open for ${formatDuration(now - session.startedAt)}`
            : 'Session start unknown';
        this._metaItem.label.text = `${[session.source, session.version].filter(Boolean).join(' ')} · PID ${session.pid}`;
    }

    setDetails(details) {
        const lines = detailLines(details);
        const text = lines.join('\n');
        if (text === this._detailText)
            return;
        this._detailText = text;

        this._detailSection.removeAll();
        if (lines.length > 0)
            this._detailSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const line of lines)
            this._detailSection.addMenuItem(new PopupMenu.PopupMenuItem(line, {reactive: false}));
    }
}

function setStateIcon(icon, state, baseClass) {
    icon.icon_name = STATE_ICON[state];
    icon.style_class = `${baseClass} agentperch-${state}`;
}

const PerchIndicator = GObject.registerClass(
class PerchIndicator extends PanelMenu.Button {
    _init(name, callbacks) {
        super._init(0.5, name);
        this._callbacks = callbacks;

        const box = new St.BoxLayout({style_class: 'agentperch-indicator'});
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this._label = new St.Label({
            style_class: 'agentperch-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            callbacks.onMenuChanged(this, isOpen);
        });
    }

    _setAppearance(state, text) {
        setStateIcon(this._icon, state, 'system-status-icon');
        this._label.text = text;
        this._label.visible = text !== '';
    }
});

const SessionIndicator = GObject.registerClass(
class SessionIndicator extends PerchIndicator {
    _init(session, callbacks) {
        super._init(`AgentPerch ${displayName(session)}`, callbacks);
        this._view = new SessionDetailsView(this.menu, callbacks.onGoToTerminal);
    }

    update(session, runningAgents, options) {
        this._session = session;
        this._setAppearance(session.state, sessionLabel(session, runningAgents, options.names));
        this._view.update(session);
    }

    openTargets() {
        return this.menu.isOpen ? [{session: this._session, view: this._view}] : [];
    }

    shownSessionKeys() {
        return [this._session.key];
    }

    onMenuOpening() {}

    ownsView(view) {
        return this._view === view;
    }
});

// Single icon mode: the most urgent state, a count when there are several sessions,
// and one expandable entry per session.
const SummaryIndicator = GObject.registerClass(
class SummaryIndicator extends PerchIndicator {
    _init(callbacks) {
        super._init('AgentPerch', callbacks);
        this._rows = new Map();
    }

    update(sessions, runningAgents) {
        const total = sessions.reduce(
            (sum, session) => sum + (runningAgents.get(session.sessionId) ?? 0), 0);
        this._setAppearance(aggregateState(sessions), summaryLabel(sessions, total));

        const live = new Set(sessions.map(session => session.key));
        for (const [key, row] of this._rows) {
            if (!live.has(key)) {
                row.item.destroy();
                this._rows.delete(key);
            }
        }

        for (const session of sessions) {
            let row = this._rows.get(session.key);
            if (!row) {
                const item = new PopupMenu.PopupSubMenuMenuItem('', true);
                this.menu.addMenuItem(item);
                row = {item, view: new SessionDetailsView(item.menu, this._callbacks.onGoToTerminal)};
                this._rows.set(session.key, row);
            }
            row.session = session;
            row.item.label.text = `${displayName(session)} — ${stateText(session)}`;
            setStateIcon(row.item.icon, session.state, 'popup-menu-icon');
            row.view.update(session);
        }
    }

    openTargets() {
        return this.menu.isOpen
            ? Array.from(this._rows.values(), ({session, view}) => ({session, view}))
            : [];
    }

    ownsView(view) {
        return Array.from(this._rows.values()).some(row => row.view === view);
    }

    shownSessionKeys() {
        return Array.from(this._rows.keys());
    }

    // Most urgent first. Only on opening, so entries never move under the pointer.
    onMenuOpening() {
        Array.from(this._rows.values())
            .sort((a, b) => compareByUrgency(a.session, b.session))
            .forEach((row, position) => {
                this.menu.moveMenuItem(row.item, position);
                // moveMenuItem moves the header only: the details must follow it.
                this.menu.box.set_child_above_sibling(row.item.menu.actor, row.item);
            });
    }
});

class Perch {
    constructor(settings, attention) {
        this._directory = sessionsDirectory();
        this._cancellable = new Gio.Cancellable();
        this._files = new SessionFiles(projectsDirectory(), this._cancellable);
        this._settings = settings;
        this._indicators = new Map();
        this._summary = null;
        this._rawSessions = [];
        this._sessions = [];
        this._attention = attention;
        this._notifier = new WaitingNotifier(session => this._goToTerminal(session));
        this._callbacks = {
            onMenuChanged: (indicator, isOpen) => this._onMenuChanged(indicator, isOpen),
            onGoToTerminal: session => this._goToTerminal(session),
        };
        this._warnedStatuses = new Set();
        this._warnedRejected = false;
        this._runningAgents = new Map();
        this._cache = new Map();
        this._scanning = false;
        this._rescanNeeded = false;
        this._detailsPending = false;
        this._detailsAgain = false;
        this._debounceId = 0;

        this._readOptions();
        this._settingsId = settings.connect('changed', () => this._onSettingsChanged());

        this._startMonitor();
        this._rescanId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, RESCAN_INTERVAL_S, () => {
                this._scan();
                return GLib.SOURCE_CONTINUE;
            });
        this._scan();
    }

    _startMonitor() {
        try {
            this._monitor = Gio.File.new_for_path(this._directory)
                .monitor_directory(Gio.FileMonitorFlags.NONE, this._cancellable);
            this._monitor.connect('changed', () => this._scheduleScan());
        } catch (e) {
            // The periodic scan keeps running: the extension still works, less responsively.
            console.warn(`AgentPerch: cannot monitor the directory: ${e.message}`);
        }
    }

    _scheduleScan() {
        if (this._debounceId)
            return;
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }

    // One scan at a time: a request received during a scan starts another one when
    // it ends, so the display never stays on a stale state.
    async _scan() {
        if (this._scanning) {
            this._rescanNeeded = true;
            return;
        }

        this._scanning = true;
        try {
            do {
                this._rescanNeeded = false;
                // eslint-disable-next-line no-await-in-loop
                const {sessions, cache, rejected} = await scanSessions(
                    this._directory, this._cache, this._cancellable);
                if (this._cancellable.is_cancelled())
                    return;
                this._cache = cache;
                this._rawSessions = sessions;
                this._warnAboutFormat(sessions, rejected);
                this._files.retain(sessions);
                this._applySessions();
                // eslint-disable-next-line no-await-in-loop
                await this._refreshAgentCounts();
                if (this._cancellable.is_cancelled())
                    return;
                this._refreshOpenMenus();
            } while (this._rescanNeeded);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`AgentPerch: scan failed: ${e.message}`);
        } finally {
            this._scanning = false;
        }
    }

    // Without this, a format change would look the same as having no session.
    _warnAboutFormat(sessions, rejected) {
        if (rejected > 0 && !this._warnedRejected) {
            this._warnedRejected = true;
            console.warn(`AgentPerch: ${rejected} session file(s) in an unknown format. ` +
                'Claude Code may have changed it.');
        }
        for (const session of sessions) {
            const status = session.rawStatus ?? 'missing';
            if (session.state === State.UNKNOWN && !this._warnedStatuses.has(status)) {
                this._warnedStatuses.add(status);
                console.warn(`AgentPerch: unrecognized status "${status}"` +
                    ` (Claude Code ${session.version ?? 'unknown'})`);
            }
        }
    }

    _applySessions() {
        this._sessions = this._attention.apply(this._rawSessions);
        this._notifier.update(this._sessions, this._options.notify);
        this._render();
    }

    _onMenuChanged(indicator, isOpen) {
        const current = indicator === this._summary ||
            Array.from(this._indicators.values()).includes(indicator);
        if (!current)
            return;

        if (isOpen) {
            indicator.onMenuOpening();
            this._refreshOpenMenus();
            return;
        }
        // On closing rather than opening, so the menu can show what finished.
        for (const key of indicator.shownSessionKeys())
            this._attention.markSeen(key);
        this._applySessions();
    }

    async _goToTerminal(session) {
        let window = null;
        try {
            const ancestors = await processAncestors(session.pid, this._cancellable);
            if (this._cancellable.is_cancelled())
                return;
            const windows = global.get_window_actors()
                .map(actor => actor.meta_window)
                .filter(candidate => !candidate.is_skip_taskbar())
                .map(candidate => ({
                    window: candidate,
                    pid: candidate.get_pid(),
                    title: candidate.get_title(),
                    userTime: candidate.get_user_time(),
                }));
            window = chooseWindow(windows, ancestors, session.name)?.window;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            console.warn(`AgentPerch: cannot look up the terminal window: ${e.message}`);
        }

        if (window) {
            this._attention.markSeen(session.key);
            this._applySessions();
            Main.activateWindow(window);
        } else {
            Main.notify('AgentPerch', `No terminal window found for ${displayName(session)}`);
        }
    }

    _readOptions() {
        this._options = {
            single: this._settings.get_string('display-mode') === 'single',
            names: this._settings.get_string('session-names'),
            notify: this._settings.get_boolean('notify-on-waiting'),
            showSubagents: this._settings.get_boolean('show-subagents'),
            showUsage: this._settings.get_boolean('show-usage'),
        };
    }

    _onSettingsChanged() {
        this._readOptions();
        // Start over: existing menus may hold data that the disabled option must no
        // longer show.
        this._destroyIndicators();
        if (!this._options.showSubagents)
            this._runningAgents.clear();
        this._applySessions();
        this._scan();
    }

    _render() {
        if (this._options.single)
            this._renderSummary();
        else
            this._renderPerSession();
    }

    _renderSummary() {
        if (this._sessions.length === 0) {
            const summary = this._summary;
            this._summary = null;
            summary?.destroy();
            return;
        }
        if (!this._summary) {
            this._summary = new SummaryIndicator(this._callbacks);
            Main.panel.addToStatusArea(SUMMARY_ROLE, this._summary, 0, 'right');
        }
        this._summary.update(this._sessions, this._runningAgents);
    }

    _renderPerSession() {
        const liveKeys = new Set(this._sessions.map(session => session.key));
        for (const [key, indicator] of this._indicators) {
            if (!liveKeys.has(key)) {
                this._indicators.delete(key);
                indicator.destroy();
            }
        }

        // Sessions are sorted by start time: the list index also gives a stable
        // position in the bar.
        this._sessions.forEach((session, position) => {
            const running = this._runningAgents.get(session.sessionId) ?? 0;
            let indicator = this._indicators.get(session.key);
            if (!indicator) {
                indicator = new SessionIndicator(session, this._callbacks);
                indicator.update(session, running, this._options);
                this._indicators.set(session.key, indicator);
                Main.panel.addToStatusArea(`agentperch-${session.key}`, indicator, position, 'right');
                return;
            }
            indicator.update(session, running, this._options);
        });
    }

    async _refreshAgentCounts() {
        if (!this._options.showSubagents)
            return;
        const sessions = this._sessions;
        const counts = await Promise.all(
            sessions.map(session => this._files.runningAgentCount(session)));
        if (this._cancellable.is_cancelled() || !this._options.showSubagents)
            return;

        this._runningAgents = new Map(
            sessions.map((session, index) => [session.sessionId, counts[index]]));
        this._render();
    }

    // Reads transcripts only for open menus.
    async _refreshOpenMenus() {
        if (this._detailsPending) {
            this._detailsAgain = true;
            return;
        }
        this._detailsPending = true;
        try {
            do {
                this._detailsAgain = false;
                const {showUsage: usage, showSubagents: subagents} = this._options;
                const indicators = this._summary ? [this._summary] : this._indicators.values();
                for (const indicator of indicators) {
                    for (const {session, view} of indicator.openTargets()) {
                        // eslint-disable-next-line no-await-in-loop
                        const details = await this._files.details(session, {usage, subagents});
                        if (this._cancellable.is_cancelled())
                            return;
                        // During the read, the option may have changed and the session may have closed.
                        const current = indicator === this._summary ||
                            this._indicators.get(session.key) === indicator;
                        if (current && indicator.ownsView(view))
                            view.setDetails(details);
                    }
                }
            } while (this._detailsAgain);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`AgentPerch: failed to read details: ${e.message}`);
        } finally {
            this._detailsPending = false;
        }
    }

    // Detached first: destroying an indicator can close its menu, whose handler
    // must then see it as gone.
    _destroyIndicators() {
        const indicators = [...this._indicators.values(), this._summary].filter(Boolean);
        this._indicators.clear();
        this._summary = null;
        for (const indicator of indicators)
            indicator.destroy();
    }

    destroy() {
        this._cancellable.cancel();

        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        GLib.source_remove(this._rescanId);
        this._debounceId = 0;
        this._rescanId = 0;

        this._monitor?.cancel();
        this._monitor = null;

        this._notifier.destroy();

        this._settings.disconnect(this._settingsId);
        this._settings = null;

        this._destroyIndicators();
        this._cache.clear();
    }
}

export default class AgentPerchExtension extends Extension {
    enable() {
        // Kept across disable(): locking the screen disables extensions, and a session
        // finishing meanwhile is exactly what "finished" is for.
        this._attention ??= new AttentionTracker();
        this._perch = new Perch(this.getSettings(), this._attention);
    }

    disable() {
        this._perch.destroy();
        this._perch = null;
    }
}
