import Clutter from 'gi://Clutter';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

const SHELL_VERSION = Number.parseInt(Config.PACKAGE_VERSION, 10);

export function boxLayoutOrientation (vertical) {
    if (SHELL_VERSION >= 51) {
        return {
            orientation: vertical
                ? Clutter.Orientation.VERTICAL
                : Clutter.Orientation.HORIZONTAL,
        };
    }

    return { vertical };
}
