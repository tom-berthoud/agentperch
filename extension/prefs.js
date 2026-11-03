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

        const display = new Adw.PreferencesGroup({title: 'Barre du haut'});
        page.add(display);

        const mode = new Adw.ComboRow({
            title: 'Affichage',
            subtitle: "L'icône unique prend l'état le plus urgent",
            model: Gtk.StringList.new(['Une icône par session', 'Une seule icône']),
        });
        mode.selected = Math.max(0, MODES.indexOf(settings.get_string('display-mode')));
        mode.connect('notify::selected', () => {
            settings.set_string('display-mode', MODES[mode.selected]);
        });
        display.add(mode);
        display.add(this._switchRow(settings, 'show-session-names', 'Nom de la session',
            "Affiché à côté de l'icône, en mode une icône par session"));

        const details = new Adw.PreferencesGroup({title: 'Détails'});
        page.add(details);
        details.add(this._switchRow(settings, 'show-subagents', 'Sous-agents',
            'Badge sur l\'icône et liste dans le menu'));
        details.add(this._switchRow(settings, 'show-usage', 'Utilisation des tokens',
            'Lit les transcripts à l\'ouverture du menu, sans en conserver le contenu'));
    }

    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
