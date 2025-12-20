export const getServerIndexTs = (title, webviewPath) => `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit, useState, useChannel, useAsync } from '@devvit/public-api';

// 1. Configuration
Devvit.configure({
  redditAPI: true,
  redis: true,
  realtime: true,
  http: true, // Enable HTTP Endpoints for Client Fetch
});

// 2. HTTP API (Express-like Endpoints)
// Allows the WebSim client to perform DB and Realtime ops via fetch()

// Helper: Standard Response
const json = (data) => new Response(JSON.stringify(data), { 
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
});
const error = (msg, status = 500) => new Response(JSON.stringify({ error: msg }), { 
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
});

// A. Database Ops
Devvit.addHttpHandler({
  method: 'POST',
  url: '/api/db/set',
  handler: async (req, context) => {
    try {
      const { collection, id, data } = await req.json();
      if (!collection || !id) return error('Missing collection or id', 400);

      const key = \`websim:col:\${collection}\`;
      await context.redis.hSet(key, { [id]: JSON.stringify(data) });
      
      return json({ success: true, id });
    } catch (e) {
      console.error('DB Set Error', e);
      return error(e.message);
    }
  },
});

Devvit.addHttpHandler({
  method: 'GET',
  url: '/api/db/get',
  handler: async (req, context) => {
    const url = new URL(req.url);
    const collection = url.searchParams.get('collection');
    
    if (!collection) return error('Missing collection', 400);
    
    try {
        const key = \`websim:col:\${collection}\`;
        const data = await context.redis.hGetAll(key);
        // Redis returns object of strings, we parse them back to objects
        const parsed = {};
        for (const [k, v] of Object.entries(data || {})) {
            try { parsed[k] = JSON.parse(v); } catch(e) { parsed[k] = v; }
        }
        return json(parsed);
    } catch (e) {
        return error(e.message);
    }
  }
});

Devvit.addHttpHandler({
  method: 'POST',
  url: '/api/db/delete',
  handler: async (req, context) => {
    try {
      const { collection, id } = await req.json();
      const key = \`websim:col:\${collection}\`;
      await context.redis.hDel(key, [id]);
      return json({ success: true });
    } catch(e) {
      return error(e.message);
    }
  }
});

// B. Realtime Ops
Devvit.addHttpHandler({
  method: 'POST',
  url: '/api/realtime/send',
  handler: async (req, context) => {
    try {
      const { channel, event } = await req.json();
      await context.realtime.send(channel || 'websim_global', event);
      return json({ success: true });
    } catch(e) {
      return error(e.message);
    }
  }
});

// 3. UI & WebView
Devvit.addCustomPostType({
  name: 'WebSim Game',
  height: 'tall',
  render: (context) => {
    const [key, setKey] = useState(0);
    
    // Get the API URL to pass to the client
    const [apiUrl] = useState(async () => {
        try {
            return await context.http.getUrl();
        } catch(e) { return ''; }
    });

    // Realtime Bridge (Subscription only)
    // The server listens to the channel and forwards messages to the WebView
    const channelName = 'websim_global';
    const channel = useChannel({
      name: channelName,
      onMessage: (msg) => {
        context.ui.webView.postMessage('gameview', {
          type: 'WEBSIM_REALTIME_MSG',
          payload: msg
        });
      },
    });

    channel.subscribe();

    return (
      <vstack height="100%" width="100%" alignment="center middle">
        <webview
          id="gameview"
          url={\`\${webviewPath}?api=\${encodeURIComponent(apiUrl || '')}\`}
          width="100%"
          height="100%"
          key={key.toString()}
          onMessage={(msg) => {
            // Log Handling
            if (msg.type === 'console' && msg.args) {
              const prefix = '[Web]';
              const args = [prefix, ...(msg.args || [])];
              if (msg.level === 'error') console.error(...args);
              else if (msg.level === 'warn') console.warn(...args);
              else if (msg.level === 'info') console.log(...args);
              else console.log(...args);
            }
          }}
        />
        <vstack padding="medium" gap="medium">
            <button icon="refresh" onPress={() => setKey(k => k + 1)}>Reload Game</button>
            <text size="small" color="neutral-content-weak">Running on Reddit Devvit</text>
        </vstack>
      </vstack>
    );
  },
});

// 4. Creation Menu
Devvit.addMenuItem({
  label: 'Create ${title.replace(/'/g, "\\'")}',
  location: 'subreddit',
  onPress: async (_event, context) => {
    const { reddit, ui } = context;
    try {
      const subreddit = await reddit.getCurrentSubreddit();
      const post = await reddit.submitPost({
        title: '${title.replace(/'/g, "\\'")}',
        subredditName: subreddit.name,
        preview: (
          <vstack height="100%" width="100%" alignment="center middle">
            <text size="large">Loading Game...</text>
          </vstack>
        ),
      });
      ui.showToast('Game created!');
      ui.navigateTo(post);
    } catch (error) {
      console.error('Error creating post:', error);
      ui.showToast('Failed to create game post');
    }
  },
});

export default Devvit;
`;

