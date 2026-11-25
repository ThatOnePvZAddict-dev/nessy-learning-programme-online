/* Answers the Zinc "mdm" calls that nlp.swf makes, in the browser. */
(() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const norm = p => String(p ?? '').replace(/[\\:]/g, '/').replace(/\/+/g, '/').replace(/^(\.\/|\/)+/, '').toLowerCase();
  let M = { files: {}, dirs: [] }, dirs = new Set(), SQL = null;
  const overlay = new Map(), deleted = new Set(), cache = new Map(), newDirs = new Set();
  let db = null, dbPath = '', rows = [], err = '', saveTimer = 0;

  // One shared connection (the old code opened a new one on every save and never closed it).
  let dbp = null, blocked = false, resetting = false, dirty = false;
  const idb = () => dbp || (dbp = new Promise((ok, no) => {
    const r = indexedDB.open('nessy-web', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const d = r.result; d.onversionchange = d.onclose = () => { try { d.close(); } catch {} dbp = null; }; ok(d); };
    r.onerror = () => { dbp = null; no(r.error); };
  }));
  // Reads throw on failure so a failed read can never be mistaken for "no saved progress".
  const idbGet = async k => { const d = await idb(); return await new Promise((ok, no) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); }); };
  // Resolves only once the write has actually been committed.
  const idbPut = async (k, v) => {
    try {
      const d = await idb();
      await new Promise((ok, no) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = ok; t.onerror = t.onabort = () => no(t.error); });
      return true;
    } catch (e) { saveFailed(e); return false; }
  };
  const saveFailed = e => { lg('SAVE ERROR', String((e && e.message) || e)); if (!window.nlpSaveFailed) { window.nlpSaveFailed = true; window.dispatchEvent(new Event('nlpsaveerror')); } };
  const saveNow = () => {
    clearTimeout(saveTimer);
    if (!dirty || blocked || resetting) return;
    dirty = false;
    idbPut('state', { o: [...overlay], d: [...deleted], n: [...newDirs] }).then(ok => { if (!ok) dirty = true; });
  };
  const persist = () => { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); };
  // Don't lose the last <400ms of progress when the tab is closed or backgrounded.
  addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });

  function fetchSync(p) {                       // last resort for files not preloaded
    const x = new XMLHttpRequest(); x.open('GET', p, false); x.overrideMimeType('text/plain; charset=x-user-defined');
    try { x.send(); } catch { return null; }
    if (x.status !== 200) return null;
    const s = x.responseText, u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u;
  }
  const exists = p => overlay.has(p) || (!deleted.has(p) && p in M.files);
  const read = p => overlay.get(p) || (deleted.has(p) ? null : cache.get(p) || (p in M.files ? (cache.set(p, fetchSync(p)), cache.get(p)) : null));
  const write = (p, b) => { overlay.set(p, b); deleted.delete(p); persist(); };
  const isDir = p => { p = p.replace(/\/$/, ''); return dirs.has(p) || newDirs.has(p) || [...overlay.keys()].some(k => k.startsWith(p + '/')); };
  const str = r => (r == null ? '' : String(r));
  const flush = () => { if (db) write(dbPath, db.export()); };

  const api = {
    'FileSystem.fileExists': p => exists(norm(p)),
    'FileSystem.folderExists': p => isDir(norm(p)),
    'FileSystem.copyFile': (a, b) => { const d = read(norm(a)); if (!d) return false; write(norm(b), d.slice()); return true; },
    'FileSystem.copyFolder': () => true,
    'FileSystem.makeFolder': p => { newDirs.add(norm(p).replace(/\/$/, '')); persist(); return true; },
    'FileSystem.deleteFile': p => { p = norm(p); overlay.delete(p); deleted.add(p); persist(); return true; },
    'FileSystem.deleteFolder': () => true,
    'FileSystem.saveFile': (p, s) => { write(norm(p), enc.encode(str(s))); return true; },
    'FileSystem.appendFile': (p, s) => { p = norm(p); const o = read(p) || new Uint8Array(), a = enc.encode(str(s)), n = new Uint8Array(o.length + a.length); n.set(o); n.set(a, o.length); write(p, n); return true; },
    'FileSystem.loadFile': p => { const d = read(norm(p)); return d ? dec.decode(d) : ''; },
    // Zinc: returns an array of bare file names in `dir` matching a glob mask such as "*.usr". Always an array.
    'FileSystem.getFileList': (dir, mask) => {
      const d = norm(dir).replace(/\/$/, ''), pre = d ? d + '/' : '';
      const re = new RegExp('^' + String(mask || '*').toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      const out = new Set();
      const add = k => {
        if (!k.startsWith(pre) || deleted.has(k)) return;
        const r = k.slice(pre.length);
        if (r && !r.includes('/') && re.test(r)) out.add(r);
      };
      Object.keys(M.files).forEach(add); overlay.forEach((_, k) => add(k));
      return [...out].sort();
    },
    'FileSystem.getFileSize': p => { p = norm(p); const d = overlay.get(p) || cache.get(p); return d ? d.length : (deleted.has(p) ? 0 : (M.files[p] ?? 0)); },
    'FileSystem.getFileAttribs': () => 'N',
    'FileSystem.getCurrentDir': () => '',
    'Dialogs.prompt': m => { alert(m); return true; },
    'Dialogs.promptAdv': () => true,
    'Dialogs.BrowseFolder.show': () => '',
    'System.exec': p => { p = norm(p); if (p.endsWith('.pdf')) window.open(p, '_blank'); return true; },
    'System.execStdOut': () => '',
    'System.getTotalSpace': () => 1e12, 'System.getFreeSpace': () => 1e12,
    'System.Registry.keyExists': () => false, 'System.Registry.loadString': () => '', 'System.Registry.saveString': () => true,
    'Flash.allowScale': () => {}, 'Exception.trapErrors': () => {}, 'Exception.resetHandler': () => {}, 'Exception.enableHandler': () => {},
    'Application.shake': () => {}, 'Application.minimize': () => {}, 'Application.exit': () => { document.body.classList.add('closed'); },
    'Database.SQLite.open': p => { flush(); dbPath = norm(p); const d = read(dbPath); try { db = d ? new SQL.Database(d) : new SQL.Database(); err = ''; } catch (e) { db = null; err = String(e); } return !err; },
    'Database.SQLite.close': () => { flush(); if (db) db.close(); db = null; },
    'Database.SQLite.runQuery': q => {
      err = ''; rows = [];
      try { const r = db.exec(q); if (r.length) rows = r[r.length - 1].values.map(row => row.map(v => (v === null ? 'undefined' : String(v)))); if (!/^\s*select/i.test(q)) flush(); }
      catch (e) { err = String(e.message || e); }
    },
    'Database.SQLite.error': () => !!err,
    'Database.SQLite.errorDetails': () => err,
    'Database.SQLite.getRecordCount': () => rows.length,
    'Database.SQLite.getField': (r, c) => (rows[r] ? rows[r][c] : ''),
    'Database.SQLite.getData': () => rows,
  };
  const DEBUG = /[?&]debug\b/.test(location.search);
  const LOG = []; let logRaf = 0;
  const clip = (k, v) => (typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v);
  const lg = (...a) => {
    const t = a.map(x => { try { return typeof x === 'string' ? x.slice(0, 300) : JSON.stringify(x, clip); } catch { return String(x); } }).join(' ').slice(0, 300);
    LOG.push(t); if (LOG.length > 2000) LOG.splice(0, 1000);                 // was unbounded
    if (DEBUG) console.log('[nlp]', t);
    if (!logRaf) logRaf = requestAnimationFrame(() => { logRaf = 0; const e = document.getElementById('log'); if (e && e.offsetParent !== null) { e.textContent = LOG.slice(-400).join('\n'); e.scrollTop = 1e9; } });
  };
  window.nlpLog = () => LOG.join('\n'); window.addEventListener('error', e => lg('JS error', e.message));
  const host = (name, args) => {
    if (name === 'consts') return { 'Application.path': '', 'Application.isMinimized': false, 'System.Paths.temp': 'tmp/', 'System.Paths.desktop': '', 'System.screenWidth': screen.width, 'System.screenHeight': screen.height };
    const f = api[name]; if (!f) { lg('UNHANDLED', name, args); return null; }
    try { const r = f(...(args || [])); lg(name, args, '=>', name === 'Database.SQLite.getData' ? r.length + ' rows' : r); return r; } catch (e) { lg('ERR', name, String(e)); return null; }
  };
  window.nlpHost = (name, args) => { if (name === 'consts') lg('consts requested'); return host(name, args); };

  window.nlpBoot = async (status) => {
    status('Reading file list…');
    const mr = await fetch('manifest.json');
    if (!mr.ok) throw new Error('manifest.json could not be loaded (' + mr.status + ')');
    M = await mr.json(); dirs = new Set(M.dirs);
    status('Starting database engine…');
    SQL = await initSqlJs({ locateFile: f => 'sqljs/' + f });
    status('Restoring your saved progress…');
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}   // ask the browser not to evict saved progress
    let s;
    try { s = await idbGet('state'); } catch (e) { blocked = true; saveFailed(e); }                     // never overwrite progress we couldn't read
    if (s) { s.o.forEach(([k, v]) => overlay.set(k, v)); s.d.forEach(k => deleted.add(k)); s.n.forEach(k => newDirs.add(k)); }
    status('Loading starter databases…');
    const need = Object.keys(M.files).filter(k => k.startsWith('user/') && k.endsWith('.nlp') && !overlay.has(k) && !deleted.has(k));
    await Promise.all(need.map(async k => {
      try { const r = await fetch(k); if (r.ok) cache.set(k, new Uint8Array(await r.arrayBuffer())); } catch (e) { lg('preload failed', k, String(e)); }
    }));
  };
  window.nlpReset = async () => {
    resetting = true; clearTimeout(saveTimer);                                  // stop any pending save from resurrecting old progress
    if (await idbPut('state', { o: [], d: [], n: [] })) location.reload();
    else { resetting = false; alert('Sorry, saved progress could not be erased.'); }
  };
})();
