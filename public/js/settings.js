const KEY = 'sp-settings';
const DEFAULTS = { units: 'kmh', shake: true, fov: 62, steerAssist: true, throttleAssist: true, speedFx: true, dynRes: true, hudScale: 1, debug: false, wheelLock: 360, wheelAxes: { throttle: 2, brake: 5 } };

let cur = { ...DEFAULTS };
try { Object.assign(cur, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* private mode */ }

export const settings = cur;
export function saveSettings(patch = {}) {
  Object.assign(cur, patch);
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* ignore */ }
  document.documentElement.style.setProperty('--hud-scale', cur.hudScale);
}
document.documentElement.style.setProperty('--hud-scale', cur.hudScale);
