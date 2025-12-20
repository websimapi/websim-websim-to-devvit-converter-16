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
    'use strict';
    
    // Request tracking
    const pendingRequests = new Map();
    let requestCounter = 0;
    
    /**
     * Generate unique request ID
     */
    function generateReqId() {
        return \`req_\${++requestCounter}_\${Date.now()}_\${Math.random().toString(36).substr(2, 9)}\`;
    }
    
    /**
     * Send message and wait for response
     */
    function sendRequest(type, payload = {}, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const reqId = generateReqId();
            
            // Set timeout
            const timeoutId = setTimeout(() => {
                pendingRequests.delete(reqId);
                reject(new Error(\`Request timeout: \${type}\`));
            }, timeout);
            
            // Store resolver
            pendingRequests.set(reqId, {
                resolve: (data) => {
                    clearTimeout(timeoutId);
                    pendingRequests.delete(reqId);
                    resolve(data);
                },
                reject: (error) => {
                    clearTimeout(timeoutId);
                    pendingRequests.delete(reqId);
                    reject(error);
                }
            });
            
            // Send message to parent (Devvit)
            window.parent.postMessage({
                type,
                reqId,
                ...payload
            }, '*');
        });
    }
    
    /**
     * Listen for responses from Devvit server
     */
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || !msg.type) return;
        
        // Handle request responses
        if (msg.reqId && pendingRequests.has(msg.reqId)) {
            const { resolve, reject } = pendingRequests.get(msg.reqId);
            
            if (msg.error) {
                reject(new Error(msg.error));
            } else {
                resolve(msg);
            }
            return;
        }
        
        // Handle broadcast events (realtime, etc)
        if (msg.type === 'REALTIME_EVENT') {
            window.dispatchEvent(new CustomEvent('devvit:realtime', {
                detail: msg.payload
            }));
        }
    });
    
    /**
     * Public API
     */
    window.DevvitAPI = {
        async dbSet(collection, id, data) {
            if (!collection || !id) throw new Error('dbSet requires collection and id');
            const response = await sendRequest('DB_SET', { collection, id, data });
            return { success: response.success, id: response.id };
        },
        
        async dbGet(collection) {
            if (!collection) throw new Error('dbGet requires collection name');
            const response = await sendRequest('DB_GET', { collection });
            return response.data || {};
        },
        
        async dbDelete(collection, id) {
            if (!collection || !id) throw new Error('dbDelete requires collection and id');
            const response = await sendRequest('DB_DELETE', { collection, id });
            return { success: response.success };
        },
        
        async realtimeSend(event) {
            window.parent.postMessage({ type: 'REALTIME_SEND', event }, '*');
            return { success: true };
        },
        
        onRealtimeMessage(callback) {
            const handler = (e) => callback(e.detail);
            window.addEventListener('devvit:realtime', handler);
            return () => window.removeEventListener('devvit:realtime', handler);
        }
    };
    
    console.log('[DevvitAPI] PostMessage bridge initialized');
})();
`;

export const websimSocketPolyfill = `/**
 * WebSim Socket -> Devvit PostMessage Bridge
 * 
 * Maps WebSim Room/Collection API to Devvit's postMessage + Redis backend
 * This version uses the DevvitAPI (postMessage) instead of fake HTTP endpoints
 */

console.log('[WebSim Socket] Initializing PostMessage Bridge...');

const _clientId = 'user_' + Math.random().toString(36).substr(2, 9);

/**
 * Collection class - manages a data collection with realtime sync
 */
class WebsimCollection {
    constructor(name, socket) {
        this.name = name;
        this.socket = socket;
        this.records = [];
        this.subs = [];
        this.loaded = false;
        this.loading = false;
        
        // Start loading data
        this._load();
    }
    
    async _load() {
        if (this.loading) return;
        this.loading = true;
        
        try {
            const dataMap = await window.DevvitAPI.dbGet(this.name);
            this.records = Object.values(dataMap);
            this.loaded = true;
            this._notify();
        } catch (error) {
            console.error(\`[WebSim DB] Failed to load collection "\${this.name}"\`, error);
            this.loaded = true; // Mark as loaded even on error to prevent infinite retries
        } finally {
            this.loading = false;
        }
    }
    
    getList() {
        const sorted = this.records.sort((a, b) => {
            const aTime = new Date(a.created_at || 0).getTime();
            const bTime = new Date(b.created_at || 0).getTime();
            return bTime - aTime; // Newest first
        });
        
        // Return array-like object with all array methods
        // This allows game code to call .filter(), .map(), etc.
        return sorted;
    }
    
    // Expose array methods directly on collection for convenience
    filter(...args) {
        return this.getList().filter(...args);
    }
    
    map(...args) {
        return this.getList().map(...args);
    }
    
    find(...args) {
        return this.getList().find(...args);
    }
    
    findIndex(...args) {
        return this.getList().findIndex(...args);
    }
    
    forEach(...args) {
        return this.getList().forEach(...args);
    }
    
    some(...args) {
        return this.getList().some(...args);
    }
    
    every(...args) {
        return this.getList().every(...args);
    }
    
    reduce(...args) {
        return this.getList().reduce(...args);
    }
    
    get length() {
        return this.records.length;
    }
    
    async create(data) {
        const id = \`\${this.name}_\${Date.now()}_\${Math.random().toString(36).substr(2, 9)}\`;
        const record = {
            id,
            ...data,
            created_at: new Date().toISOString(),
            username: 'Player' // Could be enhanced with real user data
        };
        
        // Optimistic update
        this.records.push(record);
        this._notify();
        
        try {
            // Persist to Devvit Redis
            await window.DevvitAPI.dbSet(this.name, id, record);
            
            // Broadcast to other clients
            this.socket.send({
                type: 'db_sync',
                collection: this.name,
                op: { cmd: 'create', data: record }
            });
            
            return record;
        } catch (error) {
            // Rollback on error
            console.error('[WebSim DB] Create failed', error);
            this.records = this.records.filter(r => r.id !== id);
            this._notify();
            throw error;
        }
    }
    
    async update(id, data) {
        const idx = this.records.findIndex(r => r.id === id);
        if (idx === -1) {
            throw new Error(\`Record not found: \${id}\`);
        }
        
        const oldRecord = this.records[idx];
        const record = { ...oldRecord, ...data };
        
        // Optimistic update
        this.records[idx] = record;
        this._notify();
        
        try {
            await window.DevvitAPI.dbSet(this.name, id, record);
            
            // Broadcast sync
            this.socket.send({
                type: 'db_sync',
                collection: this.name,
                op: { cmd: 'update', data: record }
            });
            
            return record;
        } catch (error) {
            // Rollback
            console.error('[WebSim DB] Update failed', error);
            this.records[idx] = oldRecord;
            this._notify();
            throw error;
        }
    }
    
    async delete(id) {
        const idx = this.records.findIndex(r => r.id === id);
        if (idx === -1) return; // Already deleted
        
        const oldRecord = this.records[idx];
        
        // Optimistic delete
        this.records = this.records.filter(r => r.id !== id);
        this._notify();
        
        try {
            await window.DevvitAPI.dbDelete(this.name, id);
            
            // Broadcast sync
            this.socket.send({
                type: 'db_sync',
                collection: this.name,
                op: { cmd: 'delete', data: { id } }
            });
        } catch (error) {
            // Rollback
            console.error('[WebSim DB] Delete failed', error);
            this.records.splice(idx, 0, oldRecord);
            this._notify();
            throw error;
        }
    }
    
    subscribe(callback) {
        this.subs.push(callback);
        
        // Immediately call with current data if loaded
        if (this.loaded) {
            callback(this.getList());
        }
        
        // Return unsubscribe function
        return () => {
            this.subs = this.subs.filter(s => s !== callback);
        };
    }
    
    _notify() {
        const list = this.getList();
        this.subs.forEach(cb => {
            try {
                cb(list);
            } catch (error) {
                console.error('[WebSim Collection] Subscriber error', error);
            }
        });
    }
    
    /**
     * Handle remote operations from other clients
     */
    _handleRemoteOp(op) {
        if (op.cmd === 'create') {
            // Don't duplicate if already exists
            if (!this.records.find(r => r.id === op.data.id)) {
                this.records.push(op.data);
            }
        } else if (op.cmd === 'update') {
            const idx = this.records.findIndex(r => r.id === op.data.id);
            if (idx !== -1) {
                this.records[idx] = op.data;
            } else {
                // Record doesn't exist locally, add it
                this.records.push(op.data);
            }
        } else if (op.cmd === 'delete') {
            this.records = this.records.filter(r => r.id !== op.data.id);
        }
        
        this._notify();
    }
}

/**
 * WebsimSocket - Main API compatible with WebSim games
 */
class WebsimSocket {
    constructor() {
        this.clientId = _clientId;
        this.collections = {};
        this.connected = false;
        this.listeners = {};
        
        // Stub properties for compatibility
        this.roomState = {};
        this.presence = {};
        this.peers = {};
        
        // Listen for realtime events
        this._unsubscribeRealtime = window.DevvitAPI.onRealtimeMessage((payload) => {
            // Ignore self-sent messages (they echo back)
            if (payload.senderId === this.clientId) return;
            
            const { type, data } = payload;
            
            // Handle DB sync events
            if (type === 'db_sync') {
                const { collection, op } = data;
                if (this.collections[collection]) {
                    this.collections[collection]._handleRemoteOp(op);
                }
                return;
            }
            
            // Handle custom events
            this._handleRemoteEvent(type, data, payload.senderId);
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
        
        // Announce join
        this.send({
            type: 'join',
            data: {
                username: 'Player',
                id: this.clientId
            }
        });
        
        return Promise.resolve();
    }
    
    send(eventData) {
        const type = eventData.type || 'broadcast_event';
        const payload = eventData.data || eventData;
        
        // Send via realtime
        window.DevvitAPI.realtimeSend({
            type,
            data: payload,
            senderId: this.clientId
        }).catch(error => {
            console.error('[WebSim Socket] Send error', error);
        });
    }
    
    _handleRemoteEvent(type, data, senderId) {
        // Trigger onmessage handler if set
        if (this.onmessage) {
            this.onmessage({
                data: {
                    type,
                    ...data,
                    clientId: senderId
                }
            });
        }
        
        // Trigger specific listeners
        const handlers = this.listeners[type] || [];
        handlers.forEach(handler => {
            try {
                handler({ type, data, senderId });
            } catch (error) {
                console.error('[WebSim Socket] Event handler error', error);
            }
        });
    }
    
    on(eventType, handler) {
        if (!this.listeners[eventType]) {
            this.listeners[eventType] = [];
        }
        this.listeners[eventType].push(handler);
    }
    
    off(eventType, handler) {
        if (!this.listeners[eventType]) return;
        this.listeners[eventType] = this.listeners[eventType].filter(h => h !== handler);
    }
    
    // Stub methods for compatibility
    updatePresence() {
        console.warn('[WebSim Socket] updatePresence() not fully implemented');
    }
    
    updateRoomState() {
        console.warn('[WebSim Socket] updateRoomState() not fully implemented');
    }
    
    subscribePresence() {
        return () => {};
    }
    
    subscribeRoomState() {
        return () => {};
    }
    
    subscribePresenceUpdateRequests() {
        return () => {};
    }
    
    disconnect() {
        if (this._unsubscribeRealtime) {
            this._unsubscribeRealtime();
        }
        this.connected = false;
    }
}

// Create singleton instance
const socket = new WebsimSocket();
window.WebsimSocket = WebsimSocket;

// Expose as party.room (WebSim convention)
if (!window.party) {
    window.party = socket;
    window.party.room = socket;
}

// Auto-initialize
socket.initialize().catch(error => {
    console.error('[WebSim Socket] Initialization failed', error);
});

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

