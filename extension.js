import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Registry, ClipboardEntry } from './registry.js';
import { DialogManager } from './confirmDialog.js';
import { PrefsFields } from './constants.js';
import { Keyboard } from './keyboard.js';
import { boxLayoutOrientation } from './compat.js';

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

const INDICATOR_ICON = 'edit-paste-symbolic';

let DELAYED_SELECTION_TIMEOUT  = 750;
let MAX_REGISTRY_LENGTH        = 15;
let MAX_ENTRY_LENGTH           = 50;
let CACHE_ONLY_FAVORITE       = false;
let DELETE_ENABLED            = true;
let MOVE_ITEM_FIRST           = false;
let ENABLE_KEYBINDING         = true;
let PRIVATEMODE               = false;
let NOTIFY_ON_CYCLE           = true;
let CONFIRM_ON_CLEAR          = true;
let MAX_TOPBAR_LENGTH          = 15;
let TOPBAR_DISPLAY_MODE        = 1; //0 - only icon, 1 - only clipboard content, 2 - both, 3 - neither
let PASTE_ON_SELECT           = false;
let STRIP_TEXT                = false;
let KEEP_SELECTED_ON_CLEAR    = false;
let PASTE_BUTTON              = true;
let PINNED_ON_BOTTOM          = false;
let CACHE_IMAGES              = true;
let EXCLUDED_APPS               = [];
let CASE_SENSITIVE_SEARCH     = false;
let REGEX_SEARCH              = false;
let SHOW_SEARCH_BAR           = true;
let SHOW_PRIVATE_MODE         = true;
let SHOW_SETTINGS_BUTTON      = true;
let SHOW_CLEAR_HISTORY_BUTTON = true;

export default class ClipboardIndicatorExtension extends Extension {
    enable () {
        this.clipboardIndicator = new ClipboardIndicator({
            clipboard: St.Clipboard.get_default(),
            settings: this.getSettings(),
            openSettings: this.openPreferences,
            uuid: this.uuid
        });

        Main.panel.addToStatusArea('clipboardIndicator', this.clipboardIndicator, 1);
    }

    disable () {
        this.clipboardIndicator.destroy();
        this.clipboardIndicator = null;
        EXCLUDED_APPS = [];
    }
}

const ClipboardIndicator = GObject.registerClass({
    GTypeName: 'ClipboardIndicator'
}, class ClipboardIndicator extends PanelMenu.Button {
    #refreshInProgress = false;

    destroy () {
        this._destroyed = true;
        this._disconnectSettings();
        this._unbindShortcuts();
        this._disconnectSelectionListener();
        this._clearDelayedSelectionTimeout();
        this.#clearTimeouts();
        this._removeHistoryLabel();
        this._destroyNotifSource();
        this.dialogManager.destroy();
        this.keyboard.destroy();
        super.destroy();
    }

    _init (extension) {
        super._init(0.0, "ClipboardIndicator");

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen)
                this.menu.sourceActor = this;
        });

        this.extension = extension;
        this._destroyed = false;
        this.registry = new Registry(extension);
        this.keyboard = new Keyboard();
        this._settingsChangedId = null;
        this._selectionOwnerChangedId = null;
        this._historyLabel = null;
        this._buttonText = null;

        this._shortcutsBindingIds = [];
        this.clipItemsRadioGroup = [];
        this._menuReady = false;
        this._cachePolicyNeedsWrite = false;

        let hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box clipboard-indicator-hbox'
        });

        this.hbox = hbox;

        this.icon = new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon'
        });

        this._buttonText = new St.Label({
            text: _('Text will be here'),
            y_align: Clutter.ActorAlign.CENTER
        });

        this._buttonImgPreview = new St.Bin({
            style_class: 'clipboard-indicator-topbar-preview'
        });

        hbox.add_child(this.icon);
        hbox.add_child(this._buttonText);
        hbox.add_child(this._buttonImgPreview);
        this.add_child(hbox);
        this._createHistoryLabel();
        this._loadSettings();

        this.dialogManager = new DialogManager();
        this._buildMenu().then(() => {
            if (this._destroyed) {
                return;
            }
            this._updateTopbarLayout();
            this._setupListener();
        }).catch(error => {
            console.error('Clipboard Indicator: failed to build menu');
            console.error(error);
        });
    }

    #updateIndicatorContent(entry) {
        if (this.preventIndicatorUpdate) {
            return;
        }

        this._indicatorEntry = entry;
        if (TOPBAR_DISPLAY_MODE !== 1 && TOPBAR_DISPLAY_MODE !== 2)
            return;

        if (!entry || PRIVATEMODE) {
            this._buttonImgPreview.destroy_all_children();
            this._buttonText.set_text("...");
        } else {
            if (entry.isText()) {
                this._buttonText.set_text(this._truncate(entry.getStringValue(), MAX_TOPBAR_LENGTH));
                this._buttonImgPreview.destroy_all_children();
            }
            else if (entry.isImage()) {
                this._buttonText.set_text('');
                this._buttonImgPreview.destroy_all_children();
                this.registry.getEntryAsImage(entry).then(img => {
                    img.add_style_class_name('clipboard-indicator-img-preview');
                    img.y_align = Clutter.ActorAlign.CENTER;

                    // icon only renders properly in setTimeout for some arcane reason
                    this._imagePreviewTimeout = setTimeout(() => {
                        this._buttonImgPreview.set_child(img);
                    }, 0);
                });
            }
        }
    }

    async _buildMenu () {
        const clipHistory = await this._getCache();
        if (this._destroyed) {
            return;
        }
        let lastIdx = clipHistory.length - 1;
        let clipItemsArr = this.clipItemsRadioGroup;

        /* This create the search entry, which is add to a menuItem.
        The searchEntry is connected to the function for research.
        The menu itself is connected to some shitty hack in order to
        grab the focus of the keyboard. */
        this._entryItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        this.searchEntry = new St.Entry({
            name: 'searchEntry',
            style_class: 'search-entry',
            can_focus: true,
            hint_text: _('Type here to search...'),
            track_hover: true,
            x_expand: true,
            y_expand: true,
            primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic' })
        });

        this.searchEntry.get_clutter_text().connect(
            'text-changed',
            this._onSearchTextChanged.bind(this)
        );

        this._entryItem.add_child(this.searchEntry);

        this.menu.connect('open-state-changed', (self, open) => {
            this._setFocusOnOpenTimeout = setTimeout(() => {
                if (!open) return;

                if (this._focusItemOnOpen) {
                    const item = this._focusItemOnOpen;
                    this._focusItemOnOpen = null;
                    global.stage.set_key_focus(item.actor);
                } else if (SHOW_SEARCH_BAR && this.clipItemsRadioGroup.length > 0) {
                    this.searchEntry.set_text('');
                    global.stage.set_key_focus(this.searchEntry);
                } else if (this.clipItemsRadioGroup.length > 0) {
                    const currentItem = this._getCurrentlySelectedItem();
                    if (currentItem) global.stage.set_key_focus(currentItem.actor);
                } else if (SHOW_PRIVATE_MODE && this.privateModeMenuItem) {
                    global.stage.set_key_focus(this.privateModeMenuItem.actor);
                }
            }, 50);
        });

        // Create menu sections for items
        // Favorites
        this.favoritesSection = new PopupMenu.PopupMenuSection();

        this.scrollViewFavoritesMenuSection = new PopupMenu.PopupMenuSection();
        this.favoritesScrollView = new St.ScrollView({
            style_class: 'ci-history-menu-section',
            overlay_scrollbars: true
        });
        this.favoritesScrollView.add_child(this.favoritesSection.actor);

        this.scrollViewFavoritesMenuSection.actor.add_child(this.favoritesScrollView);
        this.favoritesSeparator = new PopupMenu.PopupSeparatorMenuItem();

        // History
        this.historySection = new PopupMenu.PopupMenuSection();

        this.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
        this.historyScrollView = new St.ScrollView({
            style_class: 'ci-main-menu-section ci-history-menu-section',
            overlay_scrollbars: true
        });
        this.historyScrollView.add_child(this.historySection.actor);

        this.scrollViewMenuSection.actor.add_child(this.historyScrollView);

        // Add separator
        this.historySeparator = new PopupMenu.PopupSeparatorMenuItem();

        // Add sections ordered according to settings
        if (PINNED_ON_BOTTOM) {
            this.menu.addMenuItem(this.scrollViewMenuSection);
            this.menu.addMenuItem(this.scrollViewFavoritesMenuSection);
        }
        else {
            this.menu.addMenuItem(this.scrollViewFavoritesMenuSection);
            this.menu.addMenuItem(this.scrollViewMenuSection);
        }

        // Private mode switch
        this.privateModeMenuItem = new PopupMenu.PopupSwitchMenuItem(
            _("Private mode"), PRIVATEMODE, { reactive: true });
        this.privateModeMenuItem.connect('toggled',
            this._onPrivateModeSwitch.bind(this));
        this.privateModeMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'security-medium-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }),
            0
        );
        this.menu.addMenuItem(this.privateModeMenuItem);

        // Add 'Clear' button which removes all items from cache
        this.clearMenuItem = new PopupMenu.PopupMenuItem(_('Clear history'));
        this.clearMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }),
            0
        );

        this.clearMenuItem.connect('activate', this._removeAll.bind(this));

        // Add 'Settings' menu item to open settings
        this.settingsMenuItem = new PopupMenu.PopupMenuItem(_('Settings'));
        this.settingsMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'preferences-system-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }),
            0
        );
        this.settingsMenuItem.connect('activate', this._openSettings.bind(this));

        // Empty state section
        this.emptyStateSection = new St.BoxLayout({
            style_class: 'clipboard-indicator-empty-state',
            ...boxLayoutOrientation(true),
        });
        this.emptyStateSection.add_child(new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon',
            x_align: Clutter.ActorAlign.CENTER
        }));
        this.emptyStateSection.add_child(new St.Label({
            text: _('Clipboard is empty'),
            x_align: Clutter.ActorAlign.CENTER
        }));

        // Add cached items
        clipHistory.forEach(entry => this._addEntry(entry));

        if (lastIdx >= 0) {
            this._selectMenuItem(clipItemsArr[lastIdx]);
        }

        this._menuReady = true;
        const historyWasTrimmed = this._removeOldestEntries(false);
        if (historyWasTrimmed || this._cachePolicyNeedsWrite) {
            this._cachePolicyNeedsWrite = false;
            this._updateCache();
        }
        this.#showElements();
    }

    #hideElements() {
        if (this._destroyed) {
            return;
        }
        if (this.menu.box.contains(this._entryItem)) this.menu.box.remove_child(this._entryItem);
        if (this.menu.box.contains(this.favoritesSeparator)) this.menu.box.remove_child(this.favoritesSeparator);
        if (this.menu.box.contains(this.historySeparator)) this.menu.box.remove_child(this.historySeparator);
        if (this.clearMenuItem?.actor && this.menu.box.contains(this.clearMenuItem.actor))
            this.menu.box.remove_child(this.clearMenuItem.actor);
        if (this.settingsMenuItem?.actor && this.menu.box.contains(this.settingsMenuItem.actor))
            this.menu.box.remove_child(this.settingsMenuItem.actor);
        if (this.menu.box.contains(this.emptyStateSection)) this.menu.box.remove_child(this.emptyStateSection);
    }

    #showElements() {
        if (this._destroyed) {
            return;
        }

        // Remove empty-state if items exist
        if (this.clipItemsRadioGroup.length > 0 &&
            this.menu.box.contains(this.emptyStateSection)) {
            this.menu.box.remove_child(this.emptyStateSection);
        }

        // Search bar
        if (SHOW_SEARCH_BAR && !PRIVATEMODE) {
            if (!this.menu.box.contains(this._entryItem))
                this.menu.box.insert_child_at_index(this._entryItem, 0);
        } else {
            if (this.menu.box.contains(this._entryItem))
                this.menu.box.remove_child(this._entryItem);
        }

        // Keep the private-mode switch in place; only gate its visibility
        if (this.privateModeMenuItem?.actor) {
            this.privateModeMenuItem.actor.visible = SHOW_PRIVATE_MODE;
        }

        // Favorites separator (only when there are favorites and any items at all)
        if (this.clipItemsRadioGroup.length > 0) {
            if (this.favoritesSection._getMenuItems().length > 0 && !PRIVATEMODE) {
                if (this.menu.box.contains(this.favoritesSeparator) === false) {
                    this.menu.box.insert_child_above(this.favoritesSeparator, this.scrollViewFavoritesMenuSection.actor);
                }
            }
            else if (this.menu.box.contains(this.favoritesSeparator) === true) {
                this.menu.box.remove_child(this.favoritesSeparator);
            }
        }

        // History separator (between history and toggled buttons)
        if (this.clipItemsRadioGroup.length > 0 &&
            this.historySection._getMenuItems().length > 0 && !PRIVATEMODE &&
            (SHOW_PRIVATE_MODE || SHOW_SETTINGS_BUTTON || SHOW_CLEAR_HISTORY_BUTTON)) {
            if (!this.menu.box.contains(this.historySeparator))
                this.menu.box.insert_child_above(this.historySeparator, this.scrollViewMenuSection.actor);
        } else if (this.menu.box.contains(this.historySeparator)) {
            this.menu.box.remove_child(this.historySeparator);
        }

        // If no items, render empty state and (if toggled on) only show Private/Settings
        if (this.clipItemsRadioGroup.length === 0) {
            if (!this.menu.box.contains(this.emptyStateSection))
                this.#renderEmptyState();
            // Re-append toggled buttons after the empty state
            if (this.menu.box.contains(this.settingsMenuItem?.actor))
                this.menu.box.remove_child(this.settingsMenuItem.actor);

            let index = this.menu.box.get_n_children(); // append after empty state
            if (SHOW_SETTINGS_BUTTON && this.settingsMenuItem)
                this.menu.box.insert_child_at_index(this.settingsMenuItem.actor, index++);
            return;
        }

        // Re-append toggled buttons at end in fixed order
        if (this.menu.box.contains(this.settingsMenuItem?.actor))
            this.menu.box.remove_child(this.settingsMenuItem.actor);
        if (this.menu.box.contains(this.clearMenuItem?.actor))
            this.menu.box.remove_child(this.clearMenuItem.actor);

        let index = this.menu.box.get_n_children(); // append
        if (SHOW_SETTINGS_BUTTON && this.settingsMenuItem)
            this.menu.box.insert_child_at_index(this.settingsMenuItem.actor, index++);
        if (SHOW_CLEAR_HISTORY_BUTTON && this.clearMenuItem && !PRIVATEMODE)
            this.menu.box.insert_child_at_index(this.clearMenuItem.actor, index++);
    }

    #renderEmptyState () {
        if (this._destroyed) {
            return;
        }
        this.#hideElements();
        this.menu.box.insert_child_at_index(this.emptyStateSection, 0);
    }

    /* When text change, this function will check, for each item of the
    historySection and favoritesSestion, if it should be visible or not (based on words contained
    in the clipContents attribute of the item). It doesn't destroy or create
    items. It the entry is empty, the section is restored with all items
    set as visible. */
    _onSearchTextChanged () {
        const menuItems = this._getAllIMenuItems();
        let searchedText = this.searchEntry.get_text();
        if (!CASE_SENSITIVE_SEARCH) searchedText = searchedText.toLowerCase();

        if (searchedText === '') {
            menuItems.forEach(mItem => {
                mItem.actor.visible = true;
            });
            return;
        }

        let matcher = null;
        if (REGEX_SEARCH) {
            const flags = 'm' + (CASE_SENSITIVE_SEARCH ? '' : 'i');
            try {
                matcher = new RegExp(searchedText, flags);
            } catch (error) {
                menuItems.forEach(mItem => mItem.actor.visible = false);
                return;
            }
        }

        menuItems.forEach(mItem => {
            let text = mItem.clipContents;
            if (!CASE_SENSITIVE_SEARCH)
                text = text.toLowerCase();
            mItem.actor.visible = matcher ? matcher.test(text) : text.includes(searchedText);
        });
    }

    _truncate (string, length) {
        let shortened = string.replace(/\s+/g, ' ');

        let chars = [...shortened]
        if (chars.length > length)
            shortened = chars.slice(0, length - 1).join('') + '...';

        return shortened;
    }

    _setEntryLabel (menuItem) {
        const { entry } = menuItem;
        if (entry.isText()) {
            menuItem.label.set_text(this._truncate(entry.getStringValue(), MAX_ENTRY_LENGTH));
        }
        else if (entry.isImage()) {
            this.registry.getEntryAsImage(entry).then(img => {
                img.add_style_class_name('clipboard-menu-img-preview');
                if (menuItem.previewImage) {
                    menuItem.remove_child(menuItem.previewImage);
                }
                menuItem.previewImage = img;
                menuItem.insert_child_below(img, menuItem.label);
            }).catch(error => {
                console.error('Clipboard Indicator: failed to load image preview');
                console.error(error);
            });
        }
    }

    _findNextMenuItem (currentMenutItem) {
        let currentIndex = this.clipItemsRadioGroup.indexOf(currentMenutItem);

        // for only one item
        if(this.clipItemsRadioGroup.length === 1) {
            return null;
        }

        // when focus is in middle of the displayed list
        for (let i = currentIndex - 1; i >= 0; i--) {
            let menuItem = this.clipItemsRadioGroup[i];
            if (menuItem.actor.visible) {
                return menuItem;
            }
        }

        // when focus is at the last element of the displayed list
        let beforeMenuItem = this.clipItemsRadioGroup[currentIndex + 1];
        if(beforeMenuItem.actor.visible){
          return beforeMenuItem;
        }

        return null;
    }

    #selectNextMenuItem (menuItem) {
        let nextMenuItem = this._findNextMenuItem(menuItem);

        if (nextMenuItem) {
            nextMenuItem.actor.grab_key_focus();
        } else if (this.privateModeMenuItem?.actor) {
            this.privateModeMenuItem.actor.grab_key_focus();
        }
    }

    _addEntry (entry, autoSelect, autoSetClip) {
        let menuItem = new PopupMenu.PopupMenuItem('');

        menuItem.menu = this.menu;
        menuItem.entry = entry;
        menuItem.clipContents = entry.getStringValue();
        menuItem.radioGroup = this.clipItemsRadioGroup;

        // CLICK fix for Paste on Select: clicking behaves like Enter
        menuItem.connect('activate', () => {
            if (PASTE_ON_SELECT) {
                this.#pasteItem(menuItem);
                this._onMenuItemSelectedAndMenuClose(menuItem, false);
            } else {
                this._onMenuItemSelectedAndMenuClose(menuItem, true);
            }
        });

        menuItem.connect('key-focus-in', () => {
            const viewToScroll = menuItem.entry.isFavorite() ?
                this.favoritesScrollView : this.historyScrollView;
            AnimationUtils.ensureActorVisibleInScrollView(viewToScroll, menuItem);
        });
        menuItem.actor.connect('key-press-event', (actor, event) => {
            switch (event.get_key_symbol()) {
                case Clutter.KEY_Delete:
                    this.#selectNextMenuItem(menuItem);
                    this._removeEntry(menuItem, 'delete');
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_p:
                    this.#selectNextMenuItem(menuItem);
                    this._favoriteToggle(menuItem);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_v:
                    this.#pasteItem(menuItem);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_KP_Enter:
                case Clutter.KEY_Return:
                    if (PASTE_ON_SELECT) {
                        this.#pasteItem(menuItem);
                        this._onMenuItemSelectedAndMenuClose(menuItem, false);
                    } else {
                        this._onMenuItemSelectedAndMenuClose(menuItem, true);
                    }
                    return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._setEntryLabel(menuItem);
        this.clipItemsRadioGroup.push(menuItem);

        menuItem.actionsSpacer = new St.Widget({
            x_expand: true,
        });
        menuItem.actor.add_child(menuItem.actionsSpacer);

        // Favorite button
        let iconfav = new St.Icon({
            icon_name: 'view-pin-symbolic',
            style_class: 'system-status-icon'
        });

        let icofavBtn = new St.Button({
            style_class: 'ci-pin-btn ci-action-btn',
            can_focus: true,
            child: iconfav,
            x_expand: false,
            y_expand: true
        });

        menuItem.actor.add_child(icofavBtn);
        menuItem.icofavBtn = icofavBtn;
        menuItem.favoritePressId = icofavBtn.connect('clicked',
            () => this._favoriteToggle(menuItem)
        );

        // Paste button
        menuItem.pasteBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            accessible_name: _('Paste'),
            child: new St.Icon({
                icon_name: 'edit-paste-symbolic',
                style_class: 'system-status-icon'
            }),
            x_expand: false,
            y_expand: true,
            visible: PASTE_BUTTON
        });

        menuItem.pasteBtn.connect('clicked',
            () => this.#pasteItem(menuItem)
        );

        menuItem.actor.add_child(menuItem.pasteBtn);

        // Delete button
        let icon = new St.Icon({
            icon_name: 'edit-delete-symbolic', //'mail-attachment-symbolic',
            style_class: 'system-status-icon'
        });

        let icoBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            child: icon,
            x_expand: false,
            y_expand: true
        });

        menuItem.actor.add_child(icoBtn);
        menuItem.icoBtn = icoBtn;
        menuItem.deletePressId = icoBtn.connect('clicked',
            () => this._removeEntry(menuItem, 'delete')
        );

        if (entry.isFavorite()) {
            this.favoritesSection.addMenuItem(menuItem, 0);
        } else {
            this.historySection.addMenuItem(menuItem, 0);
        }

        if (autoSelect === true) {
            this._selectMenuItem(menuItem, autoSetClip);
        }
        else {
            menuItem.setOrnament(PopupMenu.Ornament.DOT);
            if (menuItem._ornamentIcon) menuItem._ornamentIcon.opacity = 0;
        }

        this.#showElements();
    }

    _favoriteToggle (menuItem) {
        menuItem.entry.favorite = menuItem.entry.isFavorite() ? false : true;
        this._moveItemFirst(menuItem);
    }

    _confirmRemoveAll () {
        const title = _("Clear all?");
        const message = _("Are you sure you want to delete all clipboard items?");
        const sub_message = _("This operation cannot be undone.");

        this.dialogManager.open(title, message, sub_message, _("Clear"), _("Cancel"), () => {
            this._clearHistory();
        }
      );
    }

    _clearHistory () {
        // Keep pinned items and, when configured, the selected history item.
        const removedItems = new Set(this.historySection._getMenuItems().filter(mItem =>
            KEEP_SELECTED_ON_CLEAR === false || !mItem.currentlySelected
        ));

        if (removedItems.size > 0) {
            if ([...removedItems].some(mItem => mItem.currentlySelected))
                this.#clearClipboard();

            for (const mItem of removedItems) {
                mItem.destroy();
                if (mItem.entry.isImage())
                    this.registry.deleteEntryFile(mItem.entry);
            }

            const remainingItems = this.clipItemsRadioGroup.filter(item => !removedItems.has(item));
            this.clipItemsRadioGroup.length = 0;
            for (const item of remainingItems)
                this.clipItemsRadioGroup.push(item);

            this._updateCache();
            this.#showElements();
        }

        this._showNotification(_("Clipboard history cleared"));
    }

    _removeAll () {
        if (PRIVATEMODE) return;

        if (CONFIRM_ON_CLEAR) {
            this._confirmRemoveAll();
        } else {
            this._clearHistory();
        }
    }

    _removeEntry (menuItem, event, persist = true, removeImage = true, updateMenu = true) {
        let itemIdx = this.clipItemsRadioGroup.indexOf(menuItem);

        if(event === 'delete' && menuItem.currentlySelected) {
            this.#clearClipboard();
        }

        menuItem.destroy();
        this.clipItemsRadioGroup.splice(itemIdx,1);

        if (removeImage && menuItem.entry.isImage()) {
            this.registry.deleteEntryFile(menuItem.entry);
        }

        if (persist)
            this._updateCache();
        if (updateMenu)
            this.#showElements();
    }

    _removeOldestEntries (updateCache = true) {
        const clipItemsRadioGroupNoFavorite = this.clipItemsRadioGroup.filter(
            item => item.entry.isFavorite() === false);
        const excess = clipItemsRadioGroupNoFavorite.length - MAX_REGISTRY_LENGTH;
        if (excess <= 0)
            return false;

        const removedItems = new Set(clipItemsRadioGroupNoFavorite.slice(0, excess));
        const remainingItems = this.clipItemsRadioGroup.filter(item => !removedItems.has(item));

        for (const item of removedItems) {
            item.destroy();
            if (item.entry.isImage())
                this.registry.deleteEntryFile(item.entry);
        }

        // Keep the same array object because menu items use it as their radio group.
        this.clipItemsRadioGroup.length = 0;
        for (const item of remainingItems)
            this.clipItemsRadioGroup.push(item);

        if (updateCache)
            this._updateCache();
        this.#showElements();
        return true;
    }

    _onMenuItemSelected (menuItem, autoSet) {
        for (let otherMenuItem of menuItem.radioGroup) {
            let clipContents = menuItem.clipContents;

            if (otherMenuItem === menuItem && clipContents) {
                menuItem.setOrnament(PopupMenu.Ornament.DOT);
                if (menuItem._ornamentIcon) menuItem._ornamentIcon.opacity = 255;
                menuItem.currentlySelected = true;
                if (autoSet !== false)
                    this.#updateClipboard(menuItem.entry);
            }
            else {
                otherMenuItem.setOrnament(PopupMenu.Ornament.DOT);
                if (otherMenuItem._ornamentIcon) otherMenuItem._ornamentIcon.opacity = 0;
                otherMenuItem.currentlySelected = false;
            }
        }
    }

    _selectMenuItem (menuItem, autoSet) {
        this._onMenuItemSelected(menuItem, autoSet);
        this.#updateIndicatorContent(menuItem.entry);
    }

    _onMenuItemSelectedAndMenuClose (menuItem, autoSet) {
        for (let otherMenuItem of menuItem.radioGroup) {
            let clipContents = menuItem.clipContents;

            if (menuItem === otherMenuItem && clipContents) {
                menuItem.setOrnament(PopupMenu.Ornament.DOT);
                if (menuItem._ornamentIcon) menuItem._ornamentIcon.opacity = 255;
                menuItem.currentlySelected = true;
                if (autoSet !== false)
                    this.#updateClipboard(menuItem.entry);
            }
            else {
                otherMenuItem.setOrnament(PopupMenu.Ornament.DOT);
                if (otherMenuItem._ornamentIcon) otherMenuItem._ornamentIcon.opacity = 0;
                otherMenuItem.currentlySelected = false;
            }
        }

        // Ensure MOVE_ITEM_FIRST also applies when PASTE_ON_SELECT fast-path skips _refreshIndicator()
        if (PASTE_ON_SELECT && MOVE_ITEM_FIRST && !menuItem.entry.isFavorite()) {
            this._moveItemFirst(menuItem);
        }

        menuItem.menu.close();
    }

    _getCache () {
        return this.registry.read();
    }

    _updateCache () {
        const entries = this.clipItemsRadioGroup
            .map(menuItem => menuItem.entry)
            .filter(entry => CACHE_ONLY_FAVORITE == false || entry.isFavorite());

        this.registry.write(entries);
    }

    async _onSelectionChange (selection, selectionType, selectionSource) {
        if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
            this._refreshIndicator();
        }
    }

    async _refreshIndicator () {
        if (PRIVATEMODE || this._destroyed) return; // Private mode, do not.

        const focussedWindow = Shell.Global.get().display.focusWindow;
        const wmClass = focussedWindow?.get_wm_class();

        if (wmClass && EXCLUDED_APPS.includes(wmClass)) return; // Excluded app, do not.

        if (this.#refreshInProgress) return;
        this.#refreshInProgress = true;

        try {
            const result = await this.#getClipboardContent();
            if (this._destroyed) {
                return;
            }

            if (result) {
                for (let menuItem of this.clipItemsRadioGroup) {
                    if (menuItem.entry.equals(result)) {
                        this._selectMenuItem(menuItem, false);

                        if (!menuItem.entry.isFavorite() && MOVE_ITEM_FIRST) {
                            this._moveItemFirst(menuItem);
                        }

                        return;
                    }
                }

                this._addEntry(result, true, false);
                this._removeOldestEntries(false);
                this._updateCache();

            }
        }
        catch (e) {
            console.error('Clipboard Indicator: Failed to refresh indicator');
            console.error(e);
        }
        finally {
            this.#refreshInProgress = false;
        }
    }

    _moveItemFirst (item) {
        this._removeEntry(item, undefined, false, false, false);
        this._addEntry(item.entry, item.currentlySelected, false);
        this._updateCache();
    }

    _findItem (text) {
        return this.clipItemsRadioGroup.filter(
            item => item.clipContents === text)[0];
    }

    _getCurrentlySelectedItem () {
        return this.clipItemsRadioGroup.find(item => item.currentlySelected);
    }

    _getAllIMenuItems () {
        return this.historySection._getMenuItems().concat(this.favoritesSection._getMenuItems());
    }

    _setupListener () {
        const metaDisplay = Shell.Global.get().get_display();
        const selection = metaDisplay.get_selection();
        this._setupSelectionTracking(selection);
    }

    _setupSelectionTracking (selection) {
        this.selection = selection;
        this._selectionOwnerChangedId = selection.connect('owner-changed', (selection, selectionType, selectionSource) => {
            this._onSelectionChange(selection, selectionType, selectionSource);
        });
    }

    _openSettings () {
        this.extension.openSettings();
        this.menu.close();
    }

    _initNotifSource () {
        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source({
                title: 'Clipboard Indicator',
                'icon-name': INDICATOR_ICON
            });

            this._notifSource.connect('destroy', () => {
                this._notifSource = null;
            });

            Main.messageTray.add(this._notifSource);
        }
    }

    _destroyNotifSource () {
        if (this._notifSource) {
            this._notifSource.destroy();
            this._notifSource = null;
        }
    }

    _showNotification (message) {
        const dndOn = () =>
            !Main.panel.statusArea.dateMenu._indicator._settings.get_boolean(
                'show-banners',
            );
        if (PRIVATEMODE || dndOn()) {
            return;
        }

        let notification = null;

        this._initNotifSource();

        if (this._notifSource.count === 0) {
            notification = new MessageTray.Notification({
                source: this._notifSource,
                body: message,
                'is-transient': true
            });
        }
        else {
            notification = this._notifSource.notifications[0];
            notification.body = message;
            notification.clearActions();
        }

        this._notifSource.addNotification(notification);
    }

    _createHistoryLabel () {
        this._historyLabel = new St.Label({
            style_class: 'ci-notification-label',
            text: ''
        });

        global.stage.add_child(this._historyLabel);

        this._historyLabel.hide();
    }

    _removeHistoryLabel () {
        if (this._historyLabel) {
            if (this._historyLabel.get_parent()) {
                global.stage.remove_child(this._historyLabel);
            }
            this._historyLabel.destroy();
            this._historyLabel = null;
        }
    }

    togglePrivateMode () {
        this.privateModeMenuItem.toggle();
    }

    _onPrivateModeSwitch () {
        PRIVATEMODE = this.privateModeMenuItem.state;
        // We hide the history in private ModeTypee because it will be out of sync (selected item will not reflect clipboard)
        this.scrollViewMenuSection.actor.visible = !PRIVATEMODE;
        this.scrollViewFavoritesMenuSection.actor.visible = !PRIVATEMODE;
        // If we get out of private mode then we restore the clipboard to old state
        if (!PRIVATEMODE) {
            let selectList = this.clipItemsRadioGroup.filter((item) => !!item.currentlySelected);

            if (selectList.length) {
                this._selectMenuItem(selectList[0]);
            } else {
                // Nothing to return to, let's empty it instead
                this.#clearClipboard();
            }

            this.#getClipboardContent().then(entry => {
                if (!entry) return;
                this.#updateIndicatorContent(entry);
            }).catch(e => console.error(e));

            this.hbox.remove_style_class_name('private-mode');
            this.#showElements();
        } else {
            this.hbox.add_style_class_name('private-mode');
            this.#updateIndicatorContent(null);
            this.#showElements();
        }
    }

    _loadSettings () {
        this._settingsChangedId = this.extension.settings.connect('changed',
            this._onSettingsChange.bind(this));

        this._fetchSettings();

        if (ENABLE_KEYBINDING)
            this._bindShortcuts();
    }

    _fetchSettings () {
        const { settings } = this.extension;
        MAX_REGISTRY_LENGTH         = settings.get_int(PrefsFields.HISTORY_SIZE);
        MAX_ENTRY_LENGTH            = settings.get_int(PrefsFields.PREVIEW_SIZE);
        CACHE_ONLY_FAVORITE         = settings.get_boolean(PrefsFields.CACHE_ONLY_FAVORITE);
        DELETE_ENABLED              = settings.get_boolean(PrefsFields.DELETE);
        MOVE_ITEM_FIRST             = settings.get_boolean(PrefsFields.MOVE_ITEM_FIRST);
        NOTIFY_ON_CYCLE             = settings.get_boolean(PrefsFields.NOTIFY_ON_CYCLE);
        CONFIRM_ON_CLEAR            = settings.get_boolean(PrefsFields.CONFIRM_ON_CLEAR);
        ENABLE_KEYBINDING           = settings.get_boolean(PrefsFields.ENABLE_KEYBINDING);
        MAX_TOPBAR_LENGTH           = settings.get_int(PrefsFields.TOPBAR_PREVIEW_SIZE);
        TOPBAR_DISPLAY_MODE         = settings.get_int(PrefsFields.TOPBAR_DISPLAY_MODE_ID);
        PASTE_ON_SELECT             = settings.get_boolean(PrefsFields.PASTE_ON_SELECT);
        STRIP_TEXT                  = settings.get_boolean(PrefsFields.STRIP_TEXT);
        KEEP_SELECTED_ON_CLEAR      = settings.get_boolean(PrefsFields.KEEP_SELECTED_ON_CLEAR);
        PASTE_BUTTON                = settings.get_boolean(PrefsFields.PASTE_BUTTON);
        PINNED_ON_BOTTOM            = settings.get_boolean(PrefsFields.PINNED_ON_BOTTOM);
        CACHE_IMAGES                = settings.get_boolean(PrefsFields.CACHE_IMAGES);
        EXCLUDED_APPS               = settings.get_strv(PrefsFields.EXCLUDED_APPS);
        CASE_SENSITIVE_SEARCH       = settings.get_boolean(PrefsFields.CASE_SENSITIVE_SEARCH);
        REGEX_SEARCH                = settings.get_boolean(PrefsFields.REGEX_SEARCH);
        SHOW_SEARCH_BAR             = settings.get_boolean(PrefsFields.SHOW_SEARCH_BAR);
        SHOW_PRIVATE_MODE           = settings.get_boolean(PrefsFields.SHOW_PRIVATE_MODE);
        SHOW_SETTINGS_BUTTON        = settings.get_boolean(PrefsFields.SHOW_SETTINGS_BUTTON);
        SHOW_CLEAR_HISTORY_BUTTON   = settings.get_boolean(PrefsFields.SHOW_CLEAR_HISTORY_BUTTON);
    }

    _onSettingsChange (_settings, key) {
        try {
            this._fetchSettings();
            if (this._destroyed)
                return;

            let privateModeChanged = false;
            if (!SHOW_PRIVATE_MODE && PRIVATEMODE && this.privateModeMenuItem) {
                this.privateModeMenuItem.setToggleState(false);
                this._onPrivateModeSwitch();
                privateModeChanged = true;
            }

            if (this._menuReady && key === PrefsFields.HISTORY_SIZE)
                this._removeOldestEntries();

            if (this._menuReady && key === PrefsFields.PREVIEW_SIZE) {
                this._getAllIMenuItems()
                    .filter(mItem => mItem.entry.isText())
                    .forEach(mItem => this._setEntryLabel(mItem));
            }

            if (this._menuReady && key === PrefsFields.PASTE_BUTTON) {
                this._getAllIMenuItems().forEach(mItem => {
                    mItem.pasteBtn.visible = PASTE_BUTTON;
                });
            }

            if (key === PrefsFields.CACHE_ONLY_FAVORITE) {
                if (this._menuReady)
                    this._updateCache();
                else
                    this._cachePolicyNeedsWrite = true;
            }

            if (key === PrefsFields.TOPBAR_DISPLAY_MODE_ID)
                this._updateTopbarLayout();

            if (key === PrefsFields.TOPBAR_DISPLAY_MODE_ID ||
                key === PrefsFields.TOPBAR_PREVIEW_SIZE) {
                this.#updateIndicatorContent(this._indicatorEntry ?? null);
            }

            const shortcutSettings = [
                PrefsFields.BINDING_CLEAR_HISTORY,
                PrefsFields.BINDING_PREV_ENTRY,
                PrefsFields.BINDING_NEXT_ENTRY,
                PrefsFields.BINDING_TOGGLE_MENU,
                PrefsFields.BINDING_PRIVATE_MODE,
            ];
            if (key === PrefsFields.ENABLE_KEYBINDING || shortcutSettings.includes(key)) {
                if (ENABLE_KEYBINDING)
                    this._bindShortcuts();
                else
                    this._unbindShortcuts();
            }

            const visibilitySettings = [
                PrefsFields.SHOW_SEARCH_BAR,
                PrefsFields.SHOW_PRIVATE_MODE,
                PrefsFields.SHOW_SETTINGS_BUTTON,
                PrefsFields.SHOW_CLEAR_HISTORY_BUTTON,
            ];
            if (this._menuReady && (visibilitySettings.includes(key) || privateModeChanged))
                this.#showElements();

            if (this._menuReady &&
                (key === PrefsFields.REGEX_SEARCH || key === PrefsFields.CASE_SENSITIVE_SEARCH))
                this._onSearchTextChanged();
        } catch (e) {
            console.error('Clipboard Indicator: Failed to update registry');
            console.error(e);
        }
    }

    _bindShortcuts () {
        this._unbindShortcuts();
        this._bindShortcut(PrefsFields.BINDING_CLEAR_HISTORY, this._removeAll);
        this._bindShortcut(PrefsFields.BINDING_PREV_ENTRY, this._previousEntry);
        this._bindShortcut(PrefsFields.BINDING_NEXT_ENTRY, this._nextEntry);
        this._bindShortcut(PrefsFields.BINDING_TOGGLE_MENU, this._toggleMenu);
        this._bindShortcut(PrefsFields.BINDING_PRIVATE_MODE, this.togglePrivateMode);
    }

    _unbindShortcuts () {
        this._shortcutsBindingIds.forEach(
            (id) => Main.wm.removeKeybinding(id)
        );

        this._shortcutsBindingIds = [];
    }

    _bindShortcut (name, cb) {
        Main.wm.addKeybinding(
            name,
            this.extension.settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            cb.bind(this)
        );

        this._shortcutsBindingIds.push(name);
    }

    _updateTopbarLayout () {
        if(TOPBAR_DISPLAY_MODE === 0){
            this.icon.visible = true;
            this._buttonText.visible = false;
            this._buttonImgPreview.visible = false;
            this.show();
        }
        if(TOPBAR_DISPLAY_MODE === 1){
            this.icon.visible = false;
            this._buttonText.visible = true;
            this._buttonImgPreview.visible = true;
            this.show();
        }
        if(TOPBAR_DISPLAY_MODE === 2){
            this.icon.visible = true;
            this._buttonText.visible = true;
            this._buttonImgPreview.visible = true;
            this.show();
        }
        if (TOPBAR_DISPLAY_MODE === 3) {
            this.hide();
        }
    }

    _disconnectSettings () {
        if (!this._settingsChangedId)
            return;

        this.extension.settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;
    }

    _disconnectSelectionListener () {
        if (!this._selectionOwnerChangedId)
            return;

        this.selection.disconnect(this._selectionOwnerChangedId);
    }

    _clearDelayedSelectionTimeout () {
        if (this._delayedSelectionTimeoutId) {
            clearInterval(this._delayedSelectionTimeoutId);
        }
    }

    _selectEntryWithDelay (entry) {
        this._selectMenuItem(entry, false);

        this._delayedSelectionTimeoutId = setTimeout(() => {
            this._selectMenuItem(entry);  //select the item
            this._delayedSelectionTimeoutId = null;
        }, DELAYED_SELECTION_TIMEOUT);
    }

    _previousEntry () {
        if (PRIVATEMODE) return;

        this._clearDelayedSelectionTimeout();

        this._getAllIMenuItems().some((mItem, i, menuItems) => {
            if (mItem.currentlySelected) {
                i--;                                 //get the previous index
                if (i < 0) i = menuItems.length - 1; //cycle if out of bound
                let index = i + 1;                   //index to be displayed

                if(NOTIFY_ON_CYCLE) {
                    this._showNotification(index + ' / ' + menuItems.length + ': ' + menuItems[i].entry.getStringValue());
                }
                if (MOVE_ITEM_FIRST) {
                    this._selectEntryWithDelay(menuItems[i]);
                }
                else {
                    this._selectMenuItem(menuItems[i]);
                }
                return true;
            }
            return false;
        });
    }

    _nextEntry () {
        if (PRIVATEMODE) return;

        this._clearDelayedSelectionTimeout();

        this._getAllIMenuItems().some((mItem, i, menuItems) => {
            if (mItem.currentlySelected) {
                i++;                                 //get the next index
                if (i === menuItems.length) i = 0;   //cycle if out of bound
                let index = i + 1;                     //index to be displayed

                if(NOTIFY_ON_CYCLE) {
                    this._showNotification(index + ' / ' + menuItems.length + ': ' + menuItems[i].entry.getStringValue());
                }
                if (MOVE_ITEM_FIRST) {
                    this._selectEntryWithDelay(menuItems[i]);
                }
                else {
                    this._selectMenuItem(menuItems[i]);
                }
                return true;
            }
            return false;
        });
    }

    _toggleMenu () {
        this.menu.toggle();
    }

    #pasteItem (menuItem) {
        this.menu.close();
        const currentlySelected = this._getCurrentlySelectedItem();
        this.preventIndicatorUpdate = true;
        this.#updateClipboard(menuItem.entry);
        this._pastingKeypressTimeout = setTimeout(() => {
            if (this.keyboard.purpose === Clutter.InputContentPurpose.TERMINAL) {
                this.keyboard.press(Clutter.KEY_Control_L);
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
                this.keyboard.release(Clutter.KEY_Control_L);
            }
            else {
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
            }

            this._pastingResetTimeout = setTimeout(() => {
                this.preventIndicatorUpdate = false;
                if (currentlySelected && currentlySelected.entry)
                    this.#updateClipboard(currentlySelected.entry);
            }, 50);
        }, 50);
    }

    #clearTimeouts () {
        if (this._imagePreviewTimeout) clearTimeout(this._imagePreviewTimeout);
        if (this._setFocusOnOpenTimeout) clearTimeout(this._setFocusOnOpenTimeout);
        if (this._pastingKeypressTimeout) clearTimeout(this._pastingKeypressTimeout);
        if (this._pastingResetTimeout) clearTimeout(this._pastingResetTimeout);
    }

    #clearClipboard () {
        this.extension.clipboard.set_text(CLIPBOARD_TYPE, "");
        this.#updateIndicatorContent(null);
    }

    #updateClipboard (entry) {
        this.extension.clipboard.set_content(CLIPBOARD_TYPE, entry.mimetype(), entry.asBytes());
        this.#updateIndicatorContent(entry);
    }

    async #getClipboardContent () {
        const mimetypes = [
            "text/plain;charset=utf-8",
            "UTF8_STRING",
            "text/plain",
            "STRING",
            'image/gif',
            'image/png',
            'image/jpg',
            'image/jpeg',
            'image/webp',
            'image/svg+xml',
            'text/html',
        ];

        for (let type of mimetypes) {
            let result = await new Promise(resolve => this.extension.clipboard.get_content(CLIPBOARD_TYPE, type, (clipBoard, bytes) => {
                if (bytes === null || bytes.get_size() === 0) {
                    resolve(null);
                    return;
                }

                // HACK: workaround for GNOME 2nd+ copy mangling mimetypes https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/8233
                // In theory GNOME or XWayland should auto-convert this back to UTF8_STRING for legacy apps when it's needed https://gitlab.gnome.org/GNOME/gtk/-/merge_requests/5300
                if (type === "UTF8_STRING") {
                    type = "text/plain;charset=utf-8";
                }

                let contents = bytes.get_data();
                if (STRIP_TEXT && ClipboardEntry.__isText(type)) {
                    const text = new TextDecoder().decode(contents).trim();
                    if (!text) {
                        resolve(null);
                        return;
                    }
                    contents = new TextEncoder().encode(text);
                }
                resolve(new ClipboardEntry(type, contents, false));
            }));

            if (result) {
                if (!CACHE_IMAGES && result.isImage()) {
                    return null;
                }
                else {
                    return result;
                }
            }
        }

        return null;
    }
});
