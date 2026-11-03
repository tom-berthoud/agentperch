import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODES = ['per-session', 'single'];

export default class AgentPerchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const display = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(display);

        const mode = new Adw.ComboRow({
            title: 'Display',
            subtitle: 'A single icon shows the most urgent state',
            model: Gtk.StringList.new(['One icon per session', 'Single icon']),
        });
        mode.selected = Math.max(0, MODES.indexOf(settings.get_string('display-mode')));
        mode.connect('notify::selected', () => {
            settings.set_string('display-mode', MODES[mode.selected]);
        });
        display.add(mode);
        display.add(this._switchRow(settings, 'show-session-names', 'Session name',
            'Shown next to the icon, in one icon per session mode'));

        const details = new Adw.PreferencesGroup({title: 'Details'});
        page.add(details);
        details.add(this._switchRow(settings, 'show-subagents', 'Subagents',
            'Badge on the icon and list in the menu'));
        details.add(this._switchRow(settings, 'show-usage', 'Token usage',
            'Reads transcripts when a menu opens, without keeping their content'));
    }

    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
