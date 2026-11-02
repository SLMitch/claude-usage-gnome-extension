import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REFRESH_SECONDS = 300;
// Anti-rebond : ignore les rafraîchissements rapprochés déclenchés par des ouvertures
// répétées du menu (le bouton « Rafraîchir » et le minuteur passent outre, via `force`).
const MIN_REFRESH_SECONDS = 30;
const BAR_WIDTH = 240;
const SESSION_SECONDS = 5 * 3600;
const WEEK_SECONDS = 7 * 86400;
// En début de créneau la projection est trop bruitée pour être affichée.
const MIN_ELAPSED = 0.05;
// Avance de l'usage sur le temps écoulé (en points) à partir de laquelle on passe au rouge.
const PACE_CRIT_GAP = 15;

function severityClass(pct) {
    if (pct >= 90)
        return 'crit';
    if (pct >= 70)
        return 'warn';
    return '';
}

function parseReset(iso) {
    if (!iso)
        return null;
    return GLib.DateTime.new_from_iso8601(iso, null)?.to_local() ?? null;
}

function formatDuration(secs) {
    if (secs < 3600)
        return `${Math.round(secs / 60)} min`;
    if (secs < 86400)
        return `${Math.floor(secs / 3600)} h ${Math.round((secs % 3600) / 60)} min`;
    return `${Math.floor(secs / 86400)} j ${Math.floor((secs % 86400) / 3600)} h`;
}

function formatReset(reset) {
    if (!reset)
        return '';
    const secs = reset.difference(GLib.DateTime.new_now_local()) / 1e6;
    const remaining = secs <= 0 ? 'maintenant' : formatDuration(secs);
    return `Réinitialisation dans ${remaining} (${reset.format('%a %H:%M')})`;
}

// Part du créneau écoulée et usage projeté à la réinitialisation au rythme actuel.
function computePace(pct, reset, windowSecs) {
    if (!reset)
        return null;
    const remaining = reset.difference(GLib.DateTime.new_now_local()) / 1e6;
    const elapsed = Math.min(Math.max(1 - remaining / windowSecs, 0), 1);
    const pace = {elapsed, projected: null, saturation: null};
    if (elapsed >= MIN_ELAPSED) {
        pace.projected = pct / elapsed;
        // Secondes avant d'atteindre 100 % si le rythme se maintient.
        if (pace.projected >= 100)
            pace.saturation = Math.max(elapsed * windowSecs * (100 - pct) / pct, 0);
    }
    return pace;
}

// Vert si l'usage ne dépasse pas le temps écoulé, orange au-delà, rouge si l'avance est forte.
function paceClass(pct, pace) {
    const gap = Math.round(pct) - Math.round(pace.elapsed * 100);
    if (gap >= PACE_CRIT_GAP)
        return 'crit';
    if (gap > 0)
        return 'warn';
    return 'ok';
}

function formatPace(pace) {
    let text = `Temps écoulé : ${Math.round(pace.elapsed * 100)} %`;
    if (pace.saturation === 0)
        text += ' · limite atteinte';
    else if (pace.saturation !== null) {
        const at = GLib.DateTime.new_now_local().add_seconds(pace.saturation);
        text += ` · saturation vers ${at.format('%a %H:%M')} (dans ${formatDuration(pace.saturation)})`;
    } else if (pace.projected !== null)
        text += ` · projection : ${Math.round(pace.projected)} %`;
    return text;
}

const LimitItem = GObject.registerClass(
class LimitItem extends PopupMenu.PopupBaseMenuItem {
    _init(title) {
        super._init({reactive: false});
        const box = new St.BoxLayout({vertical: true, style_class: 'claude-usage-row', x_expand: true});
        this._title = new St.Label({text: title, style_class: 'claude-usage-title'});
        const bg = new St.Widget({style_class: 'claude-usage-bar-bg', width: BAR_WIDTH});
        this._bar = new St.Widget({style_class: 'claude-usage-bar', width: 0});
        bg.add_child(this._bar);
        // Repère du temps écoulé dans le créneau, à comparer au remplissage.
        this._marker = new St.Widget({style_class: 'claude-usage-marker', width: 2, y: -2, visible: false});
        bg.add_child(this._marker);
        this._pace = new St.Label({text: '', style_class: 'claude-usage-sub', visible: false});
        this._sub = new St.Label({text: '', style_class: 'claude-usage-sub'});
        box.add_child(this._title);
        box.add_child(bg);
        box.add_child(this._pace);
        box.add_child(this._sub);
        this.add_child(box);
        this._name = title;
    }

    update(pct, reset, pace) {
        this._title.text = `${this._name} : ${Math.round(pct)} %`;
        this._bar.width = Math.round(BAR_WIDTH * Math.min(pct, 100) / 100);
        this._bar.style_class = `claude-usage-bar ${severityClass(pct)}`;
        this._marker.visible = this._pace.visible = !!pace;
        if (pace) {
            this._marker.x = Math.round(BAR_WIDTH * pace.elapsed) - 1;
            this._pace.text = formatPace(pace);
            this._pace.style_class = `claude-usage-sub ${paceClass(pct, pace)}`;
        }
        this._sub.text = formatReset(reset);
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Claude Usage');
        this._ext = ext;
        this._session = new Soup.Session({timeout: 20});
        this._cancellable = new Gio.Cancellable();

        const box = new St.BoxLayout();
        box.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${ext.path}/icons/usage-symbolic.svg`),
            style_class: 'system-status-icon',
        }));
        this._summary = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label',
        });
        box.add_child(this._summary);
        this.add_child(box);
        this._setSummary([['…', '']]);

        this._limitsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._limitsSection);
        this._status = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._status);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Rafraîchir', () => this.refresh(true));
        this.menu.addAction('Ouvrir claude.ai/settings/usage', () =>
            Gio.AppInfo.launch_default_for_uri('https://claude.ai/settings/usage', null));

        this._openStateId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this.refresh();
        });

        this.refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _readToken() {
        // Relu à chaque requête : Claude Code renouvelle le token lui-même.
        const path = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
        const file = Gio.File.new_for_path(path);
        let bytes;
        try {
            [bytes] = await file.load_contents_async(this._cancellable);
        } catch (e) {
            throw new Error('~/.claude/.credentials.json introuvable');
        }
        const oauth = JSON.parse(new TextDecoder().decode(bytes)).claudeAiOauth;
        if (!oauth?.accessToken)
            throw new Error('Pas de token OAuth Claude');
        return oauth;
    }

    async refresh(force = false) {
        if (this._busy)
            return;
        const now = GLib.get_monotonic_time() / 1e6;
        if (!force && this._lastRefresh && now - this._lastRefresh < MIN_REFRESH_SECONDS)
            return;
        this._lastRefresh = now;
        this._busy = true;
        try {
            const oauth = await this._readToken();
            if (oauth.expiresAt && oauth.expiresAt < Date.now())
                throw new Error('Token expiré — lancez claude pour le renouveler');

            const msg = Soup.Message.new('GET', USAGE_URL);
            msg.request_headers.append('Authorization', `Bearer ${oauth.accessToken}`);
            msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
            msg.request_headers.append('User-Agent', 'claude-usage-gnome/1');
            const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
            // status_code (entier brut) plutôt que get_status() : ce dernier est marshalé via
            // l'énum Soup.Status, qui ignore les codes ajoutés après libsoup (429, 451, 529…)
            // et fait planter GJS avec « N is not a valid value for enumeration Status ».
            const status = msg.status_code;
            if (status === 401)
                throw new Error('Non autorisé (401) — lancez claude pour renouveler le token');
            if (status === 429)
                throw new Error('Limite de requêtes atteinte (429) — réessayez plus tard');
            if (status !== 200)
                throw new Error(`HTTP ${status}`);
            this._render(JSON.parse(new TextDecoder().decode(bytes.get_data())));
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._setSummary([['⚠', '']]);
            this._status.label.text = e.message;
            this._status.visible = true;
        } finally {
            this._busy = false;
        }
    }

    // parts : liste de [texte, classe CSS] affichés côte à côte dans la barre.
    _setSummary(parts) {
        this._summary.destroy_all_children();
        for (const [text, styleClass] of parts) {
            this._summary.add_child(new St.Label({
                text,
                style_class: styleClass,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
    }

    _render(data) {
        const limits = [];
        if (Array.isArray(data.limits)) {
            for (const l of data.limits) {
                let name;
                if (l.kind === 'session')
                    name = 'Session (5 h)';
                else if (l.kind === 'weekly_all')
                    name = 'Hebdomadaire (tous modèles)';
                else
                    name = `Hebdomadaire — ${l.scope?.model?.display_name ?? l.scope?.surface ?? l.kind}`;
                limits.push({kind: l.kind, name, pct: l.percent ?? 0, reset: l.resets_at});
            }
        } else {
            if (data.five_hour)
                limits.push({kind: 'session', name: 'Session (5 h)', pct: data.five_hour.utilization, reset: data.five_hour.resets_at});
            if (data.seven_day)
                limits.push({kind: 'weekly_all', name: 'Hebdomadaire', pct: data.seven_day.utilization, reset: data.seven_day.resets_at});
        }

        this._limitsSection.removeAll();
        for (const l of limits) {
            l.reset = parseReset(l.reset);
            l.pace = computePace(l.pct, l.reset, l.kind === 'session' ? SESSION_SECONDS : WEEK_SECONDS);
            const item = new LimitItem(l.name);
            item.update(l.pct, l.reset, l.pace);
            this._limitsSection.addMenuItem(item);
        }

        const s = limits.find(l => l.kind === 'session');
        const w = limits.find(l => l.kind === 'weekly_all');
        // « 22% (44%) · 29% (32%) » : usage puis, en petit, part du créneau écoulée.
        const parts = [];
        for (const l of [s, w].filter(Boolean)) {
            if (parts.length)
                parts.push([' · ', '']);
            const sev = severityClass(l.pct);
            parts.push([`${Math.round(l.pct)}%`, sev ? `claude-usage-${sev}` : '']);
            if (l.pace)
                parts.push([`(${Math.round(l.pace.elapsed * 100)}%)`, `claude-usage-pace ${paceClass(l.pct, l.pace)}`]);
        }
        this._setSummary(parts.length ? parts : [['—', '']]);

        this._status.label.text = `Mis à jour à ${GLib.DateTime.new_now_local().format('%H:%M')}`;
        this._status.visible = true;
    }

    destroy() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._openStateId) {
            this.menu.disconnect(this._openStateId);
            this._openStateId = null;
        }
        this._cancellable.cancel();
        this._session.abort();
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
