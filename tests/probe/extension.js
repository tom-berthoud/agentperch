// Extension de test, chargée uniquement par scripts/headless-check.sh.
// Elle écrit l'état réel de la barre dans un fichier et répond à des commandes
// déposées sous forme de fichiers.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');

const TARGET_UUID = 'agentperch@tom-berthoud.github.io';

function indicatorEntries() {
    return Object.entries(Main.panel.statusArea)
        .filter(([role]) => role.startsWith('agentperch-'));
}

// Aplatit sections et sous-menus ; les séparateurs n'ont pas de texte.
function menuLines(menu) {
    return menu._getMenuItems().flatMap(item => {
        if (item instanceof PopupMenu.PopupMenuSection)
            return menuLines(item);
        const text = item.label?.text ? [item.label.text] : [];
        return item.menu ? [...text, ...menuLines(item.menu)] : text;
    });
}

function dumpState() {
    const rightBox = Main.panel._rightBox.get_children();
    const indicators = indicatorEntries().map(([role, indicator]) => ({
        role,
        label: indicator._label.text,
        icon: indicator._icon.icon_name,
        styleClass: indicator._icon.style_class,
        position: rightBox.indexOf(indicator.container),
        menu: menuLines(indicator.menu),
    }));
    indicators.sort((a, b) => a.position - b.position);

    const target = Main.extensionManager.lookup(TARGET_UUID);
    return {
        extensionState: target?.state ?? null,
        extensionError: target?.error ?? null,
        indicators,
        windows: global.get_window_actors().map(actor => actor.meta_window.get_title()),
    };
}

async function screenshot(path) {
    const stream = Gio.File.new_for_path(path)
        .replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}

export default class ProbeExtension extends Extension {
    enable() {
        const root = GLib.getenv('AGENTPERCH_PROBE_DIR');
        this._busy = false;
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._tick(root).catch(e => console.error(`probe: ${e.message}\n${e.stack}`));
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _tick(root) {
        if (this._busy)
            return;
        this._busy = true;
        try {
            GLib.file_set_contents(`${root}/state.tmp`, JSON.stringify(dumpState()));
            GLib.rename(`${root}/state.tmp`, `${root}/state.json`);

            const consume = name => {
                const path = `${root}/${name}`;
                if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                    return false;
                GLib.unlink(path);
                return true;
            };

            if (consume('cmd-open-menu'))
                indicatorEntries()[0]?.[1].menu.open(false);
            if (consume('cmd-close-menu'))
                indicatorEntries()[0]?.[1].menu.close(false);
            if (consume('cmd-screenshot')) {
                await screenshot(`${root}/screenshot.png`);
                GLib.file_set_contents(`${root}/screenshot-done`, '');
            }
            if (consume('cmd-disable'))
                Main.extensionManager.disableExtension(TARGET_UUID);
            if (consume('cmd-enable'))
                Main.extensionManager.enableExtension(TARGET_UUID);
        } finally {
            this._busy = false;
        }
    }

    disable() {
        GLib.source_remove(this._id);
    }
}
