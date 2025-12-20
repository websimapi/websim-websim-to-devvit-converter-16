export const getServerMainTsx = (title, webviewPath) => `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit, useState, useChannel, useAsync } from '@devvit/public-api';

// Configuration
Devvit.configure({
  redditAPI: true,
  redis: true,
  realtime: true,
});

// Add a menu item to the subreddit menu for instantiating the game
Devvit.addMenuItem({
  label: 'Add Game',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const { reddit, ui } = context;
    const subreddit = await reddit.getCurrentSubreddit();
    await reddit.submitPost({
      title: '${title.replace(/'/g, "\\'")}',
      subredditName: subreddit.name,
      // The preview appears while the post loads
      preview: (
        <vstack height="100%" width="100%" alignment="middle center">
          <text size="large">Loading Game...</text>
        </vstack>
      ),
    });
    ui.showToast({ text: 'Created Game Post!' });
  },
});

// Custom Post Type with WebView
Devvit.addCustomPostType({
  name: '${title.replace(/'/g, "\\'")}',
  height: 'tall',
  render: (context) => {
    const [key, setKey] = useState(0);
    
    // Realtime Channel for multiplayer sync
    const channelName = \`game_\${context.postId || 'global'}\`;
    const channel = useChannel({
      name: channelName,
      onMessage: (msg) => {
        // Forward realtime messages to WebView
        context.ui.webView.postMessage('gameview', {
          type: 'REALTIME_EVENT',
          payload: msg
        });
      },
    });
    
    channel.subscribe();

    // Get current user safely
    // Note: useAsync returns an object { data, loading, error } in recent Devvit versions
    const { data: currentUser } = useAsync(async () => {
      try {
        const user = await context.reddit.getCurrentUser();
        return user?.username || 'Anonymous';
      } catch (e) {
        return 'Anonymous';
      }
    });

    // Message Handler - Acts as the Communications Hub
    // Translates Client (WebSim) requests to Server (Devvit/Redis) actions
    const handleWebViewMessage = async (msg) => {
      try {
        // 1. Console Logging
        if (msg.type === 'console') {
          const prefix = '[WebView]';
          const args = [prefix, ...(msg.args || [])];
          if (msg.level === 'error') console.error(...args);
          else if (msg.level === 'warn') console.warn(...args);
          else console.log(...args);
          return;
        }

        // 2. Realtime Relay
        if (msg.type === 'REALTIME_SEND') {
          const { event } = msg;
          await context.realtime.send(channelName, event);
          // Echo back to sender so they know it sent (optional, but good for sync)
          // context.ui.webView.postMessage('gameview', { type: 'REALTIME_EVENT', payload: event });
          return;
        }

        // 3. Database Operations (Hotswap Layer)
        // Using direct async/await in the handler as supported by standard Devvit WebView architecture
        
        if (msg.type === 'DB_SET') {
          const { collection, id, data, reqId } = msg;
          await context.redis.hSet(\`websim:col:\${collection}\`, { 
            [id]: JSON.stringify(data) 
          });
          
          context.ui.webView.postMessage('gameview', {
            type: 'DB_SET_RESPONSE',
            reqId,
            success: true,
            id
          });
        } 
        
        else if (msg.type === 'DB_GET') {
          const { collection, reqId } = msg;
          const raw = await context.redis.hGetAll(\`websim:col:\${collection}\`);
          const parsed = {};
          
          for (const [k, v] of Object.entries(raw || {})) {
            try { parsed[k] = JSON.parse(v); } catch (e) { parsed[k] = v; }
          }
          
          context.ui.webView.postMessage('gameview', {
            type: 'DB_GET_RESPONSE',
            reqId,
            data: parsed
          });
        } 
        
        else if (msg.type === 'DB_DELETE') {
          const { collection, id, reqId } = msg;
          await context.redis.hDel(\`websim:col:\${collection}\`, [id]);
          
          context.ui.webView.postMessage('gameview', {
            type: 'DB_DELETE_RESPONSE',
            reqId,
            success: true
          });
        }

      } catch (error) {
        console.error('[Devvit Server Error]', error);
        if (msg.reqId) {
          context.ui.webView.postMessage('gameview', {
            type: \`\${msg.type}_RESPONSE\`,
            reqId: msg.reqId,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    };

    // Build WebView URL with username
    const webviewUrl = \`${webviewPath}?username=\${encodeURIComponent(currentUser || 'Anonymous')}\`;

    return (
      <vstack height="100%" width="100%" alignment="center middle">
        <webview
          id="gameview"
          url={webviewUrl}
          width="100%"
          height="100%"
          key={key.toString()}
          onMessage={handleWebViewMessage}
        />
        <vstack padding="medium" gap="medium">
          <button icon="refresh" onPress={() => setKey(k => k + 1)}>
            Reload Game
          </button>
          <text size="small" color="neutral-content-weak">
            Playing as {currentUser || 'Anonymous'}
          </text>
        </vstack>
      </vstack>
    );
  },
});

export default Devvit;
`;

