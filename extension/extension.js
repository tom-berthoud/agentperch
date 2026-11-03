import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {scanSessions, sessionsDirectory} from './lib/claudeCode.js';
import {
    State,
    aggregateState,
    detailLines,
    displayName,
    formatDuration,
    prettyPath,
    shortLabel,
    stateText,
} from './lib/model.js';
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
    [State.IDLE]: 'object-select-symbolic',
    [State.UNKNOWN]: 'dialog-question-symbolic',
};

// The detail lines of a session, in a menu or a submenu.
class SessionDetailsView {
    constructor(menu) {
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
        this._detailSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._detailSection);
        this._detailText = '';
    }

    update(session) {
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
        this._metaItem.label.text = `${session.source} · PID ${session.pid}`;
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
    _init(name, onMenuOpened) {
        super._init(0.5, name);

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
            if (isOpen)
                onMenuOpened();
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
    _init(session, onMenuOpened) {
        super._init(`AgentPerch ${displayName(session)}`, onMenuOpened);
        this._view = new SessionDetailsView(this.menu);
    }

    update(session, runningAgents, options) {
        this._session = session;
        const name = options.showNames ? shortLabel(session) : '';
        const badge = runningAgents > 0 ? `+${runningAgents}` : '';
        this._setAppearance(session.state, [name, badge].filter(Boolean).join(' '));
        this._view.update(session);
    }

    openTargets() {
        return this.menu.isOpen ? [{session: this._session, view: this._view}] : [];
    }

    ownsView(view) {
        return this._view === view;
    }
});

// Single icon mode: the most urgent state, the number of sessions, and one
// expandable entry per session.
const SummaryIndicator = GObject.registerClass(
class SummaryIndicator extends PerchIndicator {
    _init(onMenuOpened) {
        super._init('AgentPerch', onMenuOpened);
        this._rows = new Map();
    }

    update(sessions, runningAgents, options) {
        const total = sessions.reduce(
            (sum, session) => sum + (runningAgents.get(session.sessionId) ?? 0), 0);
        const badge = total > 0 ? ` +${total}` : '';
        this._setAppearance(aggregateState(sessions), `${sessions.length}${badge}`);

        const live = new Set(sessions.map(session => session.key));
        for (const [key, row] of this._rows) {
            if (!live.has(key)) {
                row.item.destroy();
                this._rows.delete(key);
            }
        }

        // A new session is the most recent one: appending it keeps the order.
        for (const session of sessions) {
            let row = this._rows.get(session.key);
            if (!row) {
                const item = new PopupMenu.PopupSubMenuMenuItem('', true);
                this.menu.addMenuItem(item);
                row = {item, view: new SessionDetailsView(item.menu)};
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
});

class Perch {
    constructor(settings) {
        this._directory = sessionsDirectory();
        this._cancellable = new Gio.Cancellable();
        this._files = new SessionFiles(projectsDirectory(), this._cancellable);
        this._settings = settings;
        this._indicators = new Map();
        this._summary = null;
        this._sessions = [];
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
                const {sessions, cache} = await scanSessions(
                    this._directory, this._cache, this._cancellable);
                if (this._cancellable.is_cancelled())
                    return;
                this._cache = cache;
                this._sessions = sessions;
                this._files.retain(sessions);
                this._render();
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

    _readOptions() {
        this._options = {
            single: this._settings.get_string('display-mode') === 'single',
            showNames: this._settings.get_boolean('show-session-names'),
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
        this._render();
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
            this._summary?.destroy();
            this._summary = null;
            return;
        }
        if (!this._summary) {
            this._summary = new SummaryIndicator(() => this._refreshOpenMenus());
            Main.panel.addToStatusArea(SUMMARY_ROLE, this._summary, 0, 'right');
        }
        this._summary.update(this._sessions, this._runningAgents, this._options);
    }

    _renderPerSession() {
        const liveKeys = new Set(this._sessions.map(session => session.key));
        for (const [key, indicator] of this._indicators) {
            if (!liveKeys.has(key)) {
                indicator.destroy();
                this._indicators.delete(key);
            }
        }

        // Sessions are sorted by start time: the list index also gives a stable
        // position in the bar.
        this._sessions.forEach((session, position) => {
            const running = this._runningAgents.get(session.sessionId) ?? 0;
            let indicator = this._indicators.get(session.key);
            if (!indicator) {
                indicator = new SessionIndicator(session, () => this._refreshOpenMenus());
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

    _destroyIndicators() {
        for (const indicator of this._indicators.values())
            indicator.destroy();
        this._indicators.clear();
        this._summary?.destroy();
        this._summary = null;
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

        this._settings.disconnect(this._settingsId);
        this._settings = null;

        this._destroyIndicators();
        this._cache.clear();
    }
}

export default class AgentPerchExtension extends Extension {
    enable() {
        this._perch = new Perch(this.getSettings());
    }

    disable() {
        this._perch.destroy();
        this._perch = null;
    }
}
