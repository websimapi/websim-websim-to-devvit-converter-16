export const simpleLoggerJs = `
(function() {
  // Enhanced logger that forwards console events to Devvit host
  const _log = console.log;
  const _warn = console.warn;
  const _error = console.error;
  const _info = console.info;

  function post(level, args) {
    try {
      // Filter out noisy/irrelevant logs
      const msgPreview = args.map(String).join(' ');
      if (msgPreview.includes('AudioContext was prevented') || 
          msgPreview.includes('acknowledgeRemotionLicense')) {
          return;
      }

      // Robust serialization to string for Devvit consumption
      const serialized = args.map(a => {
        if (a === undefined) return 'undefined';
        if (a === null) return 'null';
        if (a instanceof Error) return '[Error: ' + (a.message || 'unknown') + ']\\n' + (a.stack || '');
        if (typeof a === 'object') {
            try { 
                return JSON.stringify(a, (key, value) => {
                    if (typeof value === 'function') return '[Function]';
                    return value;
                }); 
            } catch(e) { return '[Circular/Object]'; }
        }
        return String(a);
      });
      
      // Send to parent (Devvit WebView wrapper)
      window.parent.postMessage({ type: 'console', level, args: serialized }, '*');
      
    } catch(e) {
        // Fallback
    }
  }

  // Override console methods
  console.log = function(...args) { _log.apply(console, args); post('info', args); };
  console.info = function(...args) { _info.apply(console, args); post('info', args); };
  console.warn = function(...args) { _warn.apply(console, args); post('warn', args); };
  console.error = function(...args) { _error.apply(console, args); post('error', args); };

  // Global Error Handler
  window.addEventListener('error', function(e) {
    post('error', ['[Uncaught Exception]', e.message, 'at', e.filename, ':', e.lineno, 'col', e.colno]);
  });
  
  // Promise Rejection Handler
  window.addEventListener('unhandledrejection', function(e) {
    post('error', ['[Unhandled Promise Rejection]', e.reason ? (e.reason.message || e.reason) : 'Unknown']);
  });

  // --- AudioContext Autoplay Fix ---
  // Browsers block AudioContext autoplay. We hook into creation to resume on first interaction.
  try {
      const _AudioContext = window.AudioContext || window.webkitAudioContext;
      if (_AudioContext) {
          const contexts = new Set();
          // Polyfill the constructor to track instances
          // We wrap in a try-catch to ensure we don't break the game if native inheritance fails
          class AudioContextPolyfill extends _AudioContext {
              constructor(opts) {
                  super(opts);
                  contexts.add(this);
              }
          }
          
          window.AudioContext = AudioContextPolyfill;
          window.webkitAudioContext = AudioContextPolyfill;
    
          const resumeAll = () => {
              contexts.forEach(ctx => {
                  try {
                      if (ctx.state === 'suspended') {
                          ctx.resume().catch(() => {});
                      }
                  } catch(e) {}
              });
          };
    
          // Listen for any interaction to unlock audio
          ['click', 'touchstart', 'touchend', 'pointerdown', 'pointerup', 'keydown', 'mousedown'].forEach(evt => 
              window.addEventListener(evt, resumeAll, { once: true, capture: true })
          );
      }
  } catch(e) {
      console.warn('[WebSim] AudioContext polyfill failed', e);
  }

  // Signal ready
  console.log('[WebSim Logger] Bridge initialized.');
})();
`;

export const devvitApiPolyfill = `
(function() {
    // 1. Initialize API Client
    const params = new URLSearchParams(window.location.search);
    const API_URL = params.get('api');
    
    if (!API_URL) console.warn('[DevvitAPI] No API URL found in query params. Database features may fail.');

    window.DevvitAPI = {
        _url: API_URL,
        
        async _req(path, body = null) {
            if (!this._url) throw new Error('Devvit API URL not configured');
            const res = await fetch(this._url + path, {
                method: body ? 'POST' : 'GET',
                headers: { 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined
            });
            if (!res.ok) throw new Error(\`API Error: \${res.status}\`);
            return res.json();
        },

        async dbSet(collection, id, data) {
            return this._req('/api/db/set', { collection, id, data });
        },

        async dbGet(collection) {
            // Returns object { id: data, ... }
            return this._req(\`/api/db/get?collection=\${collection}\`);
        },

        async dbDelete(collection, id) {
            return this._req('/api/db/delete', { collection, id });
        },

        async realtimeSend(channel, event) {
            return this._req('/api/realtime/send', { channel, event });
        }
    };
})();
`;

export const websimSocketPolyfill = `
// WebSim Socket -> Devvit API Bridge (Hotswap Version)
// Maps WebSim Room/Collection API to Devvit HTTP Endpoints & Realtime

console.log('[WebSim Socket] Initializing Hotswap Bridge...');

const _roomState = {};
const _presence = {};
const _peers = {};
const _clientId = 'user_' + Math.random().toString(36).substr(2, 9); 

class WebsimCollection {
    constructor(name, socket) {
        this.name = name;
        this.socket = socket;
        this.records = []; 
        this.subs = [];
        this.loaded = false;
        
        // Initial Load via HTTP
        this._load();
    }
    
    async _load() {
        try {
            // Fetch from Devvit Redis
            const dataMap = await window.DevvitAPI.dbGet(this.name);
            this.records = Object.values(dataMap); // It's already parsed JSON objects if my API works right
            this.loaded = true;
            this._notify();
        } catch(e) {
            console.error('[WebSim DB] Load failed', e);
        }
    }

    getList() {
        return this.records.sort((a,b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    }

    async create(data) {
        const id = Math.random().toString(36).substr(2, 12);
        const record = {
            id,
            ...data,
            created_at: new Date().toISOString(),
            username: 'Me' // Placeholder, ideally get from context
        };
        
        // Optimistic
        this.records.push(record);
        this._notify();
        
        // Persist via HTTP
        window.DevvitAPI.dbSet(this.name, id, record).catch(e => console.error(e));
        
        // Broadcast Sync
        this.socket.send({ type: 'db_sync', collection: this.name, op: { cmd: 'create', data: record } });
        
        return record;
    }

    async update(id, data) {
        const idx = this.records.findIndex(r => r.id === id);
        if (idx === -1) throw new Error("Record not found");
        
        const record = { ...this.records[idx], ...data };
        
        // Optimistic
        this.records[idx] = record;
        this._notify();

        // Persist
        window.DevvitAPI.dbSet(this.name, id, record).catch(e => console.error(e));
        
        // Sync
        this.socket.send({ type: 'db_sync', collection: this.name, op: { cmd: 'update', data: record } });
        
        return record;
    }
    
    async delete(id) {
        // Optimistic
        this.records = this.records.filter(r => r.id !== id);
        this._notify();
        
        // Persist
        window.DevvitAPI.dbDelete(this.name, id).catch(e => console.error(e));
        
        // Sync
        this.socket.send({ type: 'db_sync', collection: this.name, op: { cmd: 'delete', data: { id } } });
    }

    subscribe(cb) {
        this.subs.push(cb);
        if(this.loaded) cb(this.getList());
        return () => { this.subs = this.subs.filter(s => s !== cb); };
    }

    _notify() {
        const list = this.getList();
        this.subs.forEach(cb => cb(list));
    }

    // Called when a remote update comes in via Realtime
    _handleRemoteOp(op) {
        if (op.cmd === 'create') {
             if (!this.records.find(r => r.id === op.data.id)) this.records.push(op.data);
        } else if (op.cmd === 'update') {
            const idx = this.records.findIndex(r => r.id === op.data.id);
            if (idx !== -1) this.records[idx] = op.data;
        } else if (op.cmd === 'delete') {
            this.records = this.records.filter(r => r.id !== op.data.id);
        }
        this._notify();
    }
}

class WebsimSocket {
    constructor() {
        this.clientId = _clientId;
        this.roomState = _roomState;
        this.presence = _presence;
        this.peers = _peers;
        this.listeners = {};
        this.collections = {};
        this.connected = false;

        // Listen for Realtime Events forwarded by the Block
        window.addEventListener('message', (e) => {
            if (!e.data || e.data.type !== 'WEBSIM_REALTIME_MSG') return;
            const envelope = e.data.payload; // The message from realtime service
            const { type, payload, senderId } = envelope;

            if (senderId === this.clientId) return; // Ignore self-echo via realtime

            // Handle DB Sync Events
            if (type === 'db_sync') {
                if (this.collections[payload.collection]) {
                    this.collections[payload.collection]._handleRemoteOp(payload.op);
                }
                return;
            }

            // Normal Events
            this._handleRemoteEvent(type, payload, senderId);
        });
    }

    collection(name) {
        if (!this.collections[name]) {
            this.collections[name] = new WebsimCollection(name, this);
        }
        return this.collections[name];
    }

    async initialize() {
        console.log('[WebSim Socket] Connected.');
        this.connected = true;
        // Announce join via HTTP Realtime
        this.send({ type: 'join', data: { username: 'Player', id: this.clientId } });
        return Promise.resolve();
    }

    // Generic Send: Uses Devvit API HTTP Endpoint
    send(eventData) {
        // Wrap in standard websim envelope
        // If eventData has type, use it, else default
        const type = eventData.type || 'broadcast_event';
        const payload = eventData.data || eventData; // Handle various websim signatures
        
        // If it's a known internal type (db_sync), send flat
        const finalType = eventData.type || 'broadcast_event';
        
        // The Payload structure depends on what we're sending.
        // For 'broadcast_event' (user custom event), payload is the data.
        
        window.DevvitAPI.realtimeSend('websim_global', {
            type: finalType,
            senderId: this.clientId,
            payload: eventData
        }).catch(e => console.error('RT Send Error', e));
    }

    _handleRemoteEvent(type, data, senderId) {
        // Reconstruct event for listener
        if (this.onmessage) {
            this.onmessage({ data: { type, ...data, clientId: senderId } });
        }
    }
    
    // Minimal stub for room/presence to prevent crashes, though 
    // full multiplayer sync requires more robust implementation
    updatePresence() {}
    updateRoomState() {}
    subscribePresence() { return () => {}; }
    subscribeRoomState() { return () => {}; }
    subscribePresenceUpdateRequests() { return () => {}; }
}

const socket = new WebsimSocket();
window.WebsimSocket = WebsimSocket;

if (!window.party) {
    window.party = socket;
    window.party.room = socket;
}

export default socket;
`;

export const websimStubsJs = `
// WebSim API Stubs for standalone running
(function() {
    if (!window.websim) {
      window.websim = {
        getCurrentUser: async () => ({
            id: 'user_' + Math.random().toString(36).substr(2,9),
            username: 'Player',
            avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
        }),
        getProject: async () => ({
            id: 'local_project',
            title: 'Local Game'
        }),
        // Polyfill upload to prevent crashes
        upload: async (blob) => {
            console.warn('[WebSim Stub] window.websim.upload called. Uploads are not fully supported in WebView.');
            // Return a local Blob URL to satisfy the promise (image will display, but won't persist)
            return URL.createObjectURL(blob);
        }
      };
    }

    // CORS Proxy Interceptor
    // Many WebSim games use proxy services to fetch external images. Devvit CSP blocks these.
    // We try to unwrap them if they point to allowed domains (like redditstatic), or just fail gracefully.
    const _fetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') {
            // Check for common proxies
            if (input.includes('api.cors.lol') || input.includes('api.codetabs.com') || input.includes('everyorigin.workers.dev')) {
                // Try to extract the real URL
                const urlMatch = input.match(/[?&](url|quest)=([^&]+)/);
                if (urlMatch && urlMatch[2]) {
                    const realUrl = decodeURIComponent(urlMatch[2]);
                    // If it's a reddit URL, use it directly (allowed by CSP)
                    if (realUrl.includes('reddit') || realUrl.includes('redd.it')) {
                        return _fetch(realUrl, init);
                    }
                }
            }
        }
        return _fetch(input, init);
    };
})();
`;

export const jsxDevProxy = `
// Shim for react/jsx-dev-runtime to work in production Vite builds
import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';

export const Fragment = _Fragment;
export const jsx = _jsx;
export const jsxs = _jsxs;

// Proxy jsxDEV to jsx (ignores the extra dev-only arguments)
export const jsxDEV = (type, props, key, isStaticChildren, source, self) => {
  return _jsx(type, props, key);
};
`;

export const websimPackageJs = `
// Bridge for "import websim from 'websim'"
const w = window.websim || {};
export default w;
// Export common methods if destructured
export const getProject = w.getProject;
export const getCurrentUser = w.getCurrentUser;
export const upload = w.upload;
`;

