var Extension = imports.misc.extensionUtils.extensions['paperwm@hedning:matrix.org'];
var Tiling = Extension.imports.tiling;
var Clutter = imports.gi.Clutter;
var Tweener = imports.ui.tweener;
var Main = imports.ui.main;
var Mainloop = imports.mainloop;
var Shell = imports.gi.Shell;
var Meta = imports.gi.Meta;
var utils = Extension.imports.utils;
var debug = utils.debug;
var Minimap = Extension.imports.minimap;

var Settings = Extension.imports.settings;
var prefs = Settings.prefs;

/*
  The stack overlay decorates the top stacked window with its icon and
  captures mouse input such that a mouse click only _activates_ the
  window. A very limited portion of the window is visible and due to
  the animation the button-up event will be triggered at an
  unpredictable position

  See #10
*/

/*
  Parent of the overlay?

  Most natural parent is the window actor, but then the overlay
  becomes visible in the clones too.

  Since the stacked windows doesn't really move it's not a big problem
  that the overlay doesn't track the window. The main challenge with
  using a different parent becomes controlling the "z-index".

  If I understand clutter correctly that can only be done by managing
  the order of the scene graph nodes. Descendants of node A will thus
  always be drawn in the same plane compared to a non-descendants.

  The overlay thus have to be parented to `global.window_group`. One
  would think that was ok, but unfortunately mutter keeps syncing the
  window_group with the window stacking and in the process destroy the
  stacking of any non-window actors.

  Adding a "clutter restack" to the `MetaScreen` `restacked` signal
  seems keep the stacking in sync (without entering into infinite
  restack loops)
*/

function createAppIcon(metaWindow, size) {
    let tracker = Shell.WindowTracker.get_default();
    let app = tracker.get_window_app(metaWindow);
    let appIcon = app ? app.create_icon_texture(size)
        : new St.Icon({ icon_name: 'icon-missing',
                        icon_size: size });
    appIcon.x_expand = appIcon.y_expand = true;
    appIcon.x_align = appIcon.y_align = Clutter.ActorAlign.END;

    return appIcon;
}

/**
 */
class ClickOverlay {
    constructor(monitor) {
        this.monitor = monitor;
        this.left = new StackOverlay(Meta.MotionDirection.LEFT, monitor);
        this.right = new StackOverlay(Meta.MotionDirection.RIGHT, monitor);

        let enterMonitor = new Clutter.Actor({reactive: true});
        this.enterMonitor = enterMonitor;
        enterMonitor.set_position(monitor.x, monitor.y);

        Main.uiGroup.add_actor(enterMonitor);
        Main.layoutManager.trackChrome(enterMonitor);

        this.signals = new utils.Signals();

        this.signals.connect(
            enterMonitor, 'motion-event',
            () => {
                this.deactivate();
                let space = Tiling.spaces.monitors.get(this.monitor);
                let display = global.display;
                let mi = space.monitor.index;
                let mru = display.get_tab_list(Meta.TabList.NORMAL,
                                               space.workspace)
                    .filter(w => !w.minimized && w.get_monitor() === mi);

                let stack = display.sort_windows_by_stacking(mru);
                // Select the highest stacked window on the monitor
                let select = stack[stack.length - 1];

                // But don't change focus if a stuck window is active
                if (display.focus_window &&
                    display.focus_window.is_on_all_workspaces())
                    select = display.focus_window;

                if (select) {
                    space.workspace.activate_with_focus(
                        select, global.get_current_time());
                } else {
                    space.workspace.activate(global.get_current_time());
                }
                return Clutter.EVENT_STOP;
            }
        );

        this.signals.connect(Main.overview, 'showing', this.hide.bind(this));
        this.signals.connect(Main.overview, 'hidden', this.show.bind(this));
    }

    activate() {
        let monitor = this.monitor;
        let d = 10;
        this.enterMonitor.set_position(monitor.x + d, monitor.y + d);
        this.enterMonitor.set_size(monitor.width - 2*d, monitor.height - 2*d);
    }

    deactivate() {
        this.enterMonitor.set_size(0, 0);
    }

    reset() {
        this.left.setTarget(null);
        this.right.setTarget(null);
    }

    hide() {
        this.left.overlay.hide();
        this.right.overlay.hide();
    }

    show() {
        if (Main.overview.visible)
            return;
        this.left.overlay.show();
        this.right.overlay.show();
    }

    destroy() {
        this.signals.destroy();
        for (let overlay of [this.left, this.right]) {
            let actor = overlay.overlay;
            overlay.signals.destroy();
            if (overlay.clone)
                overlay.clone.destroy();
            actor.destroy();
            overlay.removeBarrier();
        }
        this.enterMonitor.destroy();
    }
}

var StackOverlay = class StackOverlay {
    constructor(direction, monitor) {

        this._direction = direction;

        let overlay = new Clutter.Actor({ reactive: true
                                          , name: "stack-overlay" });

        // Uncomment to debug the overlays
        // overlay.background_color = Clutter.color_from_string('green')[1];
        // overlay.opacity = 100;

        this.monitor = monitor;

        let panelBox = Main.layoutManager.panelBox;

        overlay.y = monitor.y + panelBox.height + prefs.vertical_margin;
        overlay.height = this.monitor.height - panelBox.height - prefs.vertical_margin;
        overlay.width = Tiling.stack_margin;

        this.signals = new utils.Signals();
        this.signals.connect(overlay, 'button-release-event', () => {
            Main.activateWindow(this.target);
            if (this.clone)
                this.clone.destroy();
            return true;
        });

        this.signals.connect(overlay, 'enter-event', this.triggerPreview.bind(this));
        this.signals.connect(overlay,'leave-event', this.removePreview.bind(this));
        this.signals.connect(Settings.settings, 'changed::pressure-barrier',
                             this.updateBarrier.bind(this, true));

        this.updateBarrier();

        global.window_group.add_child(overlay);
        Main.layoutManager.trackChrome(overlay);

        this.overlay = overlay;
    }

    triggerPreview() {
        if ("_previewId" in this)
            return;
        this._previewId = Mainloop.timeout_add(100, () => {
            if (this.clone)
                this.clone.destroy();

            let [x, y, mask] = global.get_pointer();
            let actor = this.target.get_compositor_private();
            let clone = new Clutter.Clone({source: actor});
            // Remove any window clips, and show the metaWindow.clone's
            actor.remove_clip();
            Tiling.animateWindow(this.target);

            this.clone = clone;
            clone.set_scale(0.15, 0.15);
            Main.uiGroup.add_actor(clone);

            let monitor = this.monitor;
            if (this._direction === Meta.MotionDirection.RIGHT)
                x = monitor.x + monitor.width - clone.get_transformed_size()[0];
            else
                x = monitor.x;
            clone.set_position(x, y);
        });
    }

    removePreview() {
        if ("_previewId" in this) {
            Mainloop.source_remove(this._previewId);
            delete this._previewId;
        }

        if (!this.clone)
            return;

        this.clone.destroy();
        delete this.clone;
        let space = Tiling.spaces.spaceOfWindow(this.target);
        // Show the WindowActors again and re-apply clipping
        space.moveDone();
    }

    removeBarrier() {
        if (this.barrier) {
            if (this.pressureBarrier)
                this.pressureBarrier.removeBarrier(this.barrier);
            this.barrier.destroy();
            this.pressureBarrier.destroy();
            this.barrier = null;
        }
        this._removeBarrierTimeoutId = 0;
    }

    updateBarrier(force) {
        if (force)
            this.removeBarrier();

        if (this.barrier || !prefs.pressure_barrier)
            return;

        const Layout = imports.ui.layout;
        this.pressureBarrier = new Layout.PressureBarrier(100, 0.25*1000, Shell.ActionMode.NORMAL);
        // Show the overlay on fullscreen windows when applying pressure to the edge
        // The above leave-event handler will take care of hiding the overlay
        this.pressureBarrier.connect('trigger', () => {
            this.pressureBarrier._reset();
            this.pressureBarrier._isTriggered = false;
            if (this._removeBarrierTimeoutId > 0)
                Mainloop.source_remove(this._removeBarrierTimeoutId);
            this._removeBarrierTimeoutId = Mainloop.timeout_add(100, this.removeBarrier.bind(this));
            overlay.show();
        });

        const overlay = this.overlay;
        let workArea = Main.layoutManager.getWorkAreaForMonitor(this.monitor.index);
        let monitor = this.monitor;
        let x1, directions;
        if (this._direction === Meta.MotionDirection.LEFT) {
            x1 = monitor.x,
            directions = Meta.BarrierDirection.POSITIVE_X;
        } else {
            x1 = monitor.x + monitor.width - 1,
            directions = Meta.BarrierDirection.NEGATIVE_X;
        }
        this.barrier = new Meta.Barrier({
            display: global.display,
            x1, x2: x1,
            y1: workArea.y + 1,
            y2: workArea.y + workArea.height - 1,
            directions
        });
        this.pressureBarrier.addBarrier(this.barrier);
    }

    setTarget(space, index) {

        if (this.clone) {
            this.clone.destroy();
            delete this.clone;
        }

        let bail = () => {
            this.target = null;
            this.overlay.width = 0;
            this.removeBarrier();
            return false;
        };

        if (space === null) {
            // No target. Eg. if we're at the left- or right-most window
            return bail();
        }

        let mru = global.display.get_tab_list(Meta.TabList.NORMAL,
                                              space.workspace);
        let column = space[index];
        this.target = mru.filter(w => column.includes(w))[0];
        let metaWindow = this.target;

        let overlay = this.overlay;
        let actor = metaWindow.get_compositor_private();

        overlay.y = this.monitor.y + Main.layoutManager.panelBox.height + prefs.vertical_margin;

        // Assume the resize edge is at least this big (empirically found..)
        const minResizeEdge = 8;

        if (this._direction === Meta.MotionDirection.LEFT) {
            let column = space[space.indexOf(metaWindow) + 1];
            let neighbour = column && column[0];
            if (!neighbour)
                return bail(); // Should normally have a neighbour. Bail!

            let width = neighbour.clone.targetX + space.targetX - minResizeEdge;
            if (space.isPlaceable(metaWindow))
                width = Math.min(width, 1);
            overlay.x = this.monitor.x;
            overlay.width = Math.max(width, 1);
            overlay.raise(neighbour.get_compositor_private());
        } else {
            let column = space[space.indexOf(metaWindow) - 1];
            let neighbour = column && column[0];
            if (!neighbour)
                return bail(); // Should normally have a neighbour. Bail!

            let frame = neighbour.get_frame_rect();
            frame.x = neighbour.clone.targetX + space.targetX;
            let width = this.monitor.width - (frame.x + frame.width) - minResizeEdge;
            if (space.isPlaceable(metaWindow))
                width = 1;
            width = Math.max(width, 1);
            overlay.x = this.monitor.x + this.monitor.width - width;
            overlay.width = width;
            overlay.raise(neighbour.get_compositor_private());
        }

        if (space.selectedWindow.fullscreen)
            overlay.hide();
        else
            overlay.show();
        this.updateBarrier();

        return true;
    }
};
