import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODES = ['per-session', 'single'];
const NAMES = ['always', 'attention', 'never'];

export default class AgentPerchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const display = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(display);

        display.add(this._comboRow(settings, 'display-mode', MODES, 'Display',
            'A single icon shows the most urgent state',
            ['One icon per session', 'Single icon']));
        display.add(this._comboRow(settings, 'session-names', NAMES, 'Session names',
            'Next to the icon, in one icon per session mode',
            ['Always', 'Only when it needs you', 'Never']));

        const alerts = new Adw.PreferencesGroup({title: 'Notifications'});
        page.add(alerts);
        alerts.add(this._switchRow(settings, 'notify-on-waiting', 'When a session waits for you',
            'After 3 seconds of waiting. Click it to go to the terminal'));

        const details = new Adw.PreferencesGroup({title: 'Details'});
        page.add(details);
        details.add(this._switchRow(settings, 'show-subagents', 'Subagents',
            'Badge on the icon and list in the menu'));
        details.add(this._switchRow(settings, 'show-usage', 'Token usage',
            'Reads transcripts when a menu opens, without keeping their content'));
    }

    _comboRow(settings, key, values, title, subtitle, labels) {
        const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(labels)});
        row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
        row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
        return row;
    }

    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
