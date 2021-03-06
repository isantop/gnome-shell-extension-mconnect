"use strict";

// Imports
const Gettext = imports.gettext.domain('gnome-shell-extension-mconnect');
const _ = Gettext.gettext;
const Lang = imports.lang;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const St = imports.gi.St;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

// Local Imports
const Me = imports.misc.extensionUtils.getCurrentExtension();
const { log, debug, initTranslations, Settings } = Me.imports.lib;
const MConnect = Me.imports.mconnect;
const KDEConnect = Me.imports.kdeconnect;

// Externally Available Constants
var DeviceVisibility = {
    OFFLINE: 1,
    UNPAIRED: 2
};

var ServiceProvider = {
    MCONNECT: 0,
    KDECONNECT: 1
};

/** An St.Button subclass for buttons with an image and an action */
const ActionButton = new Lang.Class({
    Name: "ActionButton",
    Extends: St.Button,
    
    _init: function (name, callback, toggle=false) {
        this.parent({
            style_class: "system-menu-action",
            style: "padding: 8px;",
            child: new St.Icon({ icon_name: name }),
            toggle_mode: toggle
        });
        this.connect("clicked", callback);
    }
});

/** A PopupMenu used as an information and control center for a device */
const DeviceMenu = new Lang.Class({
    Name: "DeviceMenu",
    Extends: PopupMenu.PopupMenuSection,

    _init: function (device) {
        this.parent();

        this.device = device;
        
        // Info Bar
        this.infoBar = new PopupMenu.PopupSeparatorMenuItem(device.name);
        this.infoBar.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.addMenuItem(this.infoBar);
        
        this.batteryLabel = new St.Label();
        this.batteryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.infoBar.actor.add(this.batteryLabel);
        
        this.batteryIcon = new St.Icon({
            icon_name: "battery-missing-symbolic",
            style_class: "popup-menu-icon"
        });
        this.infoBar.actor.add(this.batteryIcon);

        // Action Bar
        this.actionBar = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        }); 
        this.addMenuItem(this.actionBar);

        this.smsButton = new ActionButton(
            "user-available-symbolic",
            Lang.bind(this, this._smsAction)
        );
        this.actionBar.actor.add(this.smsButton, { expand: true, x_fill: false });
        
        this.findButton = new ActionButton(
            "find-location-symbolic",
            Lang.bind(this, this._findAction)
        );
        this.actionBar.actor.add(this.findButton, { expand: true, x_fill: false });
        
        this.browseButton = new ActionButton(
            "folder-remote-symbolic",
            Lang.bind(this, this._browseAction),
            true
        );
        this.actionBar.actor.add(this.browseButton, { expand: true, x_fill: false });
        
        this.shareButton = new ActionButton(
            "send-to-symbolic",
            Lang.bind(this, this._shareAction)
        );
        this.actionBar.actor.add(this.shareButton, { expand: true, x_fill: false });
        
        // Browse Bar
        this.browseBar = new PopupMenu.PopupMenuSection({
            reactive: false,
            can_focus: false
        });
        this.browseBar.actor.style_class = "popup-sub-menu";
        this.browseBar.actor.visible = false;
        this.browseButton.bind_property(
            "checked",
            this.browseBar.actor,
            "visible",
            GObject.BindingFlags.DEFAULT
        );
        this.addMenuItem(this.browseBar);
        
        // Status Bar
        this.statusBar = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        this.addMenuItem(this.statusBar);

        this.statusButton = new ActionButton(
            "channel-insecure-symbolic",
            () => { (device.trusted) ? device.ping() : device.pair(); }
        );
        this.statusBar.actor.add(this.statusButton, { x_fill: false });
        
        this.statusLabel = new St.Label({
            text: "",
            y_align: Clutter.ActorAlign.CENTER
        });
        this.statusBar.actor.add(this.statusLabel, { x_expand: true });

        // Property signals
        device.connect(
            "changed::battery",
            Lang.bind(this, this._batteryChanged)
        );
        device.connect(
            "notify::name",
            Lang.bind(this, this._nameChanged)
        );
        device.connect(
            "changed::plugins",
            Lang.bind(this, this._pluginsChanged)
        );
        
        // Device Status Properties
        ["reachable", "trusted"].forEach((property) => {
            device.connect(
                "notify::" + property,
                Lang.bind(this, this._stateChanged)
            );
        });
        // TODO: MConnect doesn't call PropertiesChanged on cached devices?
        this._stateChanged(device);
    },

    // Callbacks
    _batteryChanged: function (device, variant) {
        debug("extension.DeviceMenu._batteryChanged(" + variant.deep_unpack() + ")");
        
        let [charging, level] = variant.deep_unpack();
        let icon = "battery";

        if (level < 3) {
            icon += "-empty";
        } else if (level < 10) {
            icon += "-caution";
        } else if (level < 30) {
            icon += "-low";
        } else if (level < 60) {
            icon += "-good";
        } else if (level >= 60) {
            icon += "-full";
        }

        icon = (charging) ? icon + "-charging" : icon;
        this.batteryIcon.icon_name = icon + "-symbolic";
        this.batteryLabel.text = level + "%";
    },

    _nameChanged: function (device, name) {
        debug("extension.DeviceMenu._nameChanged()");
        
        name = name.deep_unpack();
        this.nameLabel.label.text = (name === "string") ? name : device.name;
    },

    _pluginsChanged: function (device, plugins) {
        debug("extension.DeviceMenu._pluginsChanged()");

        // Plugin Buttons
        let buttons = {
            findmyphone: this.findButton,
            sftp: this.browseButton,
            share: this.shareButton,
            telephony: this.smsButton
        };
        let sensitive;

        for (let name in buttons) {
            sensitive = (device.hasOwnProperty(name));
            buttons[name].can_focus = sensitive;
            buttons[name].reactive = sensitive;
            buttons[name].track_hover = sensitive;
            buttons[name].opacity = sensitive ? 255 : 128;
        }
        
        // Battery Plugin
        if (device.trusted && device.hasOwnProperty("battery")) {
            this.batteryIcon.visible = true;
            
            this._batteryChanged(
                device,
                new GLib.Variant(
                    "(bi)",
                    [device.battery.charging, device.battery.level]
                )
            );
        } else {
            this.batteryIcon.visible = false;
            this.batteryLabel.text = "";
        }
    },

    _stateChanged: function (device, state) {
        debug("extension.DeviceMenu._stateChanged(" + this.device.gObjectPath + ")");
        
        let { reachable, trusted } = this.device;
        
        this.actionBar.actor.visible = (reachable && trusted);
        this.statusBar.actor.visible = (!reachable || !trusted);
        
        if (!trusted) {
            this.statusButton.child.icon_name = "channel-insecure-symbolic";
            this.statusLabel.text = _("Device is unpaired");
        } else if (!reachable) {
            this.statusButton.child.icon_name = "gtk-disconnect";
            this.statusLabel.text = _("Device is offline");
        }
        
        this._pluginsChanged(this.device);
    },

    // Plugin Callbacks
    _browseAction: function (button) {
        debug("extension.DeviceMenu._browseAction()");
        
        if (button.checked) {
            button.add_style_pseudo_class("active");
        } else {
            button.remove_style_pseudo_class("active");
            return;
        }
        
        if (this.device.mount()) {
            this.browseBar.actor.destroy_all_children();
            
            for (let path in this.device.mounts) {
                let mountItem = new PopupMenu.PopupMenuItem(
                    this.device.mounts[path]
                );
                mountItem.path = path;
                
                mountItem.connect("activate", (item) => {
                    button.checked = false;
                    button.remove_style_pseudo_class("active");
                    item._getTopMenu().close(true);
                    GLib.spawn_command_line_async("xdg-open " + item.path);
                });
                
                this.browseBar.addMenuItem(mountItem);
            }
        } else {
            Main.notifyError(
                this.device.name,
                _("Failed to mount device filesystem")
            );
            
            this.browseButton.checked = false;
            this.browseButton.remove_style_pseudo_class("active");
        }
    },

    _findAction: function (button) {
        debug("extension.DeviceMenu._findAction()");
        this._getTopMenu().close(true);
        this.device.ring();
    },

    _shareAction: function (button) {
        debug("extension.DeviceMenu._shareAction()");
        this._getTopMenu().close(true);
        GLib.spawn_command_line_async(
            "gjs " + Me.path + "/share.js --device=" + this.device.id
        );
    },

    _smsAction: function (button) {
        debug("extension.DeviceMenu._smsAction()");
        this._getTopMenu().close(true);
        GLib.spawn_command_line_async(
            "gjs " + Me.path + "/sms.js --device=" + this.device.id
        );
    }
});

/** An indicator representing a Device in the Status Area */
const DeviceIndicator = new Lang.Class({
    Name: "DeviceIndicator",
    Extends: PanelMenu.Button,

    _init: function (device) {
        this.parent(null, device.name + " Indicator", false);

        this.device = device;

        // Device Icon
        this.icon = new St.Icon({
            icon_name: "smartphone-disconnected",
            style_class: "system-status-icon"
        });
        this.actor.add_actor(this.icon);

        this.deviceMenu = new DeviceMenu(device);
        this.menu.addMenuItem(this.deviceMenu);

        // Signals
        Settings.connect("changed::device-visibility", () => {
            this._sync();
        });
        
        device.connect("notify::reachable", () => { this._sync(); });
        device.connect("notify::trusted", () => { this._sync(); });

        // Sync
        this._sync(device);
    },

    // Callbacks
    _sync: function (sender, cb_data) {
        debug("extension.DeviceIndicator._sync()");

        let flags = Settings.get_flags("device-visibility");
        let { reachable, trusted, type } = this.device;
        
        // Device Visibility
        if (!(flags & DeviceVisibility.UNPAIRED) && !trusted) {
            this.actor.visible = false;
        } else if (!(flags & DeviceVisibility.OFFLINE) && !reachable) {
            this.actor.visible = false;
        } else {
            this.actor.visible = true;
        }

        // Indicator Icon
        let icon = (type === "phone") ? "smartphone" : type;

        if (trusted && reachable) {
            this.icon.icon_name = icon + "-connected";
        } else if (trusted) {
            this.icon.icon_name = icon + "-trusted";
        } else {
            this.icon.icon_name = icon + "-disconnected";
        }
    },
    
    destroy: function () {
        this.deviceMenu.destroy();
        delete this.deviceMenu;
        PanelMenu.Button.prototype.destroy.call(this);
    }
});

/**
 * A System Indicator used as the hub for spawning device indicators and
 * indicating that the extension is active when there are none.
 */
const SystemIndicator = new Lang.Class({
    Name: "SystemIndicator",
    Extends: PanelMenu.SystemIndicator,

    _init: function () {
        this.parent();

        this.manager = false;
        this._indicators = {};
        
        // Notifications
        this._integrateNautilus();
        Settings.connect(
            "changed::nautilus-integration",
            Lang.bind(this, this._integrateNautilus)
        );
        
        // Select the backend service
        if (Settings.get_enum("service-provider") === ServiceProvider.MCONNECT) {
            this._backend = MConnect;
        } else {
            this._backend = KDEConnect;
        }

        // System Indicator
        this.extensionIndicator = this._addIndicator();
        this.extensionIndicator.icon_name = "phone-apple-iphone-symbolic";
        let userMenuTray = Main.panel.statusArea.aggregateMenu._indicators;
        userMenuTray.insert_child_at_index(this.indicators, 0);

        // Extension Menu
        this.extensionMenu = new PopupMenu.PopupSubMenuMenuItem(
            _("Mobile Devices"),
            true
        );
        this.extensionMenu.icon.icon_name = this.extensionIndicator.icon_name;
        this.menu.addMenuItem(this.extensionMenu);

        // Extension Menu -> [ Enable Item ]
        this.enableItem = this.extensionMenu.menu.addAction(
            _("Enable"),
            this._backend.startService
        );

        // Extension Menu -> Mobile Settings Item
        this.extensionMenu.menu.addAction(
            _("Mobile Settings"), () => {
                GLib.spawn_command_line_async(
                    "gnome-shell-extension-prefs mconnect@andyholmes.github.io"
                );
            }
        );

        //
        Main.panel.statusArea.aggregateMenu.menu.addMenuItem(this.menu, 4);

        // Watch for DBus service
        this._watchdog = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            this._backend.BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            Lang.bind(this, this._serviceAppeared),
            Lang.bind(this, this._serviceVanished)
        );

        // Watch "service-autostart" setting
        Settings.connect("changed::service-autostart", (settings, key) => {
            if (Settings.get_boolean(key) && this.manager === null) {
                this._backend.startService();
            }
        });
    },

    // The DBus interface has appeared
    _serviceAppeared: function (conn, name, name_owner, cb_data) {
        debug("extension.SystemIndicator._serviceAppeared()");
        
        this.manager = new this._backend.DeviceManager();
        this.enableItem.actor.visible = (this.manager) ? false : true;

        for (let dbusPath in this.manager.devices) {
            this._deviceAdded(this.manager, dbusPath);
        }

        // Watch for new and removed devices
        this.manager.connect(
            "device::added",
            Lang.bind(this, this._deviceAdded)
        );

        this.manager.connect(
            "device::removed",
            Lang.bind(this, this._deviceRemoved)
        );
    },

    // The DBus interface has vanished
    _serviceVanished: function (conn, name, name_owner, cb_data) {
        debug("extension.SystemIndicator._serviceVanished()");

        if (this.manager) {
            this.manager.destroy();
            this.manager = false;
        }

        this.enableItem.actor.visible = (this.manager) ? false : true;

        // Start the service or wait for it to start
        if (Settings.get_boolean("service-autostart")) {
            this._backend.startService();
        } else {
            log("waiting for service");
        }
    },

    _deviceAdded: function (manager, dbusPath) {
        debug("extension.SystemIndicator._deviceAdded(" + dbusPath + ")");

        let device = this.manager.devices[dbusPath];
        let indicator = new DeviceIndicator(device);
        
        this._indicators[dbusPath] = indicator;
        Main.panel.addToStatusArea(dbusPath, indicator);
    },

    _deviceRemoved: function (manager, dbusPath) {
        debug("extension.SystemIndicator._deviceRemoved(" + dbusPath + ")");

        Main.panel.statusArea[dbusPath].destroy();
        delete this._indicators[dbusPath];
    },
    
    _notifyNautilus: function () {
        let source = new MessageTray.SystemNotificationSource();
        Main.messageTray.add(source);
    
        let notification = new MessageTray.Notification(
            source,
            _("Nautilus extensions changed"),
            _("Restart Nautilus to apply changes"),
            { gicon: new Gio.ThemedIcon({ name: "system-file-manager-symbolic" }) }
        );
        
        notification.setTransient(true);
        notification.addAction(_("Restart"), () => {
            GLib.spawn_command_line_async("nautilus -q");
        });
        
        source.notify(notification);
    },

    _integrateNautilus: function () {
        let path = GLib.get_user_data_dir() + "/nautilus-python/extensions";
        let dir = Gio.File.new_for_path(path);
        let script = dir.get_child("nautilus-send-mconnect.py");
        let scriptExists = script.query_exists(null);
        let integrate = Settings.get_boolean("nautilus-integration");
        
        if (integrate && !scriptExists) {
            if (!dir.query_exists(null)) {
                GLib.mkdir_with_parents(path, 493); // 0755 in octal
            }
            
            script.make_symbolic_link(
                Me.path + "/nautilus-send-mconnect.py",
                null,
                null
            );
            this._notifyNautilus();
        } else if (!integrate && scriptExists) {
            script.delete(null);
            this._notifyNautilus();
        }
    },

    destroy: function () {
        this.manager.destroy();
        delete this.manager;
        
        for (let dbusPath in this._indicators) {
            Main.panel.statusArea[dbusPath].destroy();
            delete this._indicators[dbusPath];
        }

        // Destroy the UI
        this.extensionMenu.destroy();
        this.extensionIndicator.destroy();
        this.menu.destroy();

        // Stop watching for DBus Service
        Gio.bus_unwatch_name(this._watchdog);
    }
});

var systemIndicator;

function init() {
    debug("initializing extension");
    
    initTranslations();
}

function enable() {
    debug("enabling extension");

    systemIndicator = new SystemIndicator();
    
    Settings.connect("changed::service-provider", () => {
        systemIndicator.destroy();
        systemIndicator = new SystemIndicator();
    });
}

function disable() {
    debug("disabling extension");

    GObject.signal_handlers_destroy(Settings);
    systemIndicator.destroy();
}

