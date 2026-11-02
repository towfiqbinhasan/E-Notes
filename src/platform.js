// Small helpers that hide the differences between web, Electron and Android.
import { Capacitor } from '@capacitor/core';

export const desktop = window.enotesDesktop || null;      // set by electron/preload.js
export const isElectron = !!desktop;
export const isNative = Capacitor.isNativePlatform();          // Android app
export const isAndroid = Capacitor.getPlatform() === 'android';
export const isWeb = !isElectron && !isNative;

// Where Google sign-in should send the user back to.
export function oauthRedirectUrl() {
  if (isElectron) return 'enotes://auth-callback';
  if (isNative) return 'com.enotes.app://auth-callback';
  return window.location.origin + window.location.pathname;
}

/** Open a URL in the system browser (needed for Google sign-in on desktop/Android). */
export async function openExternal(url) {
  if (isElectron) return desktop.openExternal(url);
  if (isNative) {
    const { Browser } = await import('@capacitor/browser');
    return Browser.open({ url });
  }
  window.location.href = url;
}

/** Called with the full callback URL when the OS hands a deep link back to the app. */
export async function onDeepLink(cb) {
  if (isElectron) desktop.onDeepLink(cb);
  if (isNative) {
    const { App } = await import('@capacitor/app');
    const { Browser } = await import('@capacitor/browser');
    App.addListener('appUrlOpen', ({ url }) => {
      Browser.close().catch(() => {});
      cb(url);
    });
  }
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** Save (desktop/web) or share (Android) a generated PDF. Returns a short message or null if cancelled. */
export async function saveFile(name, bytes) {
  if (isElectron) {
    const path = await desktop.saveFile(name, bytes);
    return path ? `Saved to ${path}` : null;
  }
  if (isNative) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const res = await Filesystem.writeFile({ path: name, data: bytesToBase64(bytes), directory: Directory.Cache });
    try {
      await Share.share({ title: name, files: [res.uri], dialogTitle: 'Save or share PDF' });
    } catch (e) {
      if (!/cancel/i.test(String(e && e.message))) throw e;
      return null;
    }
    return 'Shared';
  }
  // Web: share sheet on phones when available, otherwise a normal download.
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const file = new File([blob], name, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ files: [file], title: name }); return 'Shared'; } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'Downloaded';
}

/** Match the Android status bar / Electron window background to the theme. */
export async function applyNativeTheme(theme) {
  if (isElectron) desktop.setTheme(theme);
  if (isNative) {
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      await StatusBar.setBackgroundColor({ color: theme === 'dark' ? '#171a23' : '#ffffff' });
      await StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light });
    } catch { /* not available */ }
  }
}

/** Android back button: run `handler`; if it returns false, minimize the app. */
export async function onBackButton(handler) {
  if (!isNative) return;
  const { App } = await import('@capacitor/app');
  App.addListener('backButton', () => {
    if (!handler()) App.minimizeApp();
  });
}
