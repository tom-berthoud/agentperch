// Notifies when a session stays in `waiting`. Off by default (see the schema).
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {State, displayName, stateText} from './model.js';

// Auto-approved prompts last less than this: they must not produce a banner.
const NOTIFY_DELAY_S = 3;

export class WaitingNotifier {
    constructor(onActivated) {
        this._onActivated = onActivated;
        this._entries = new Map();
        this._source = null;
    }

    update(sessions, enabled) {
        const waiting = enabled
            ? sessions.filter(session => session.state === State.WAITING)
            : [];
        const keys = new Set(waiting.map(session => session.key));

        for (const [key, entry] of this._entries) {
            if (!keys.has(key)) {
                this._clear(entry);
                this._entries.delete(key);
            }
        }

        for (const session of waiting) {
            const entry = this._entries.get(session.key);
            if (entry) {
                entry.session = session;
                continue;
            }
            const created = {session, notification: null, timerId: 0};
            created.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, NOTIFY_DELAY_S, () => {
                created.timerId = 0;
                this._notify(created);
                return GLib.SOURCE_REMOVE;
            });
            this._entries.set(session.key, created);
        }
    }

    _ensureSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: 'AgentPerch',
                iconName: 'dialog-warning-symbolic',
            });
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    _notify(entry) {
        const source = this._ensureSource();
        const notification = new MessageTray.Notification({
            source,
            title: `${displayName(entry.session)} is waiting for you`,
            body: stateText(entry.session),
        });
        notification.connect('activated', () => this._onActivated(entry.session));
        notification.connect('destroy', () => {
            entry.notification = null;
        });
        entry.notification = notification;
        source.addNotification(notification);
    }

    _clear(entry) {
        if (entry.timerId) {
            GLib.source_remove(entry.timerId);
            entry.timerId = 0;
        }
        entry.notification?.destroy();
    }

    destroy() {
        for (const entry of this._entries.values())
            this._clear(entry);
        this._entries.clear();
        this._source?.destroy();
        this._source = null;
    }
}
